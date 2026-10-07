import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { WalletFunding, fundingReceipt, type FundingBinding, type FundingDependencies, type NativeOffer } from './wallet-funding.js';
import { WalletApiError } from './wallet-adapter.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { IdentityStore } from './auth.js';

const binding: FundingBinding = { sender:{user:'provider',party:'provider::local',balanceCc:'10000'},receiver:{user:'atlas',party:'atlas::local',balanceCc:'0'},domain:'domain::local' };
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(),'clearroute-wallet-'));
  let status: any = null, creates=0, accepts=0;
  const requests: NativeOffer[] = [];
  const proof = (id:string): any => ({transaction:{updateId:id,synchronizerId:binding.domain,recordTime:new Date().toISOString(),events:[
    {ExercisedEvent:{templateId:'package:Splice.Wallet.TransferOffer:AcceptedTransferOffer',choice:'AcceptedTransferOffer_Complete',exerciseResult:{trackingInfo:{trackingId:requests[0].tracking_id,sender:binding.sender.party,receiver:binding.receiver.party},transferResult:{createdAmulets:[{value:'coin'}]}}}},
    {CreatedEvent:{templateId:'package:Splice.Amulet:Amulet',contractId:'coin',createArgument:{owner:binding.receiver.party,amount:{initialAmount:requests[0].amount}}}},
  ]}});
  const deps: FundingDependencies = {
    binding:async()=>structuredClone(binding),
    create:async(_b,r)=>{creates++;requests.push({...r});status={status:'created',transaction_id:'offer-tx',contract_id:'offer'};return {offer_contract_id:'offer'};},
    status:async()=>{if (!status) throw new WalletApiError(404,'Unknown');return status;},
    accept:async()=>{accepts++;status={status:'accepted',transaction_id:'accept-tx',contract_id:'accepted'};return {};},
    evidence:async(_b,id)=>proof(id),
  };
  return {directory,deps,requests,proof,setStatus(s:any){status=s;},get creates(){return creates;},get accepts(){return accepts;}};
}
test('native funding uses exact decimals, concurrent durable idempotency and recipient consent',async()=>{
  const f=fixture(),service=new WalletFunding(f.directory,f.deps);
  try {
    const [a,b]=await Promise.all([service.offer('atlas','1.0000000001','native-duplicate'),service.offer('atlas','1.0000000001','native-duplicate')]);
    assert.equal(a.id,b.id);assert.equal(f.creates,1);assert.equal(f.requests[0].amount,'1.0000000001');assert.equal(f.accepts,0);
    await assert.rejects(()=>service.offer('nova','1.0000000001','native-duplicate'),/different recipient/);
    await assert.rejects(()=>service.offer('atlas','2','native-duplicate'),/different recipient/);
    await assert.rejects(()=>service.accept(a.id,'nova'),/not found/);
    await service.accept(a.id,'atlas');assert.equal(f.accepts,1);assert.equal(service.get(a.id).receipt,null);
    f.setStatus({status:'completed',transaction_id:'delivery',contract_id:'coin'});await service.reconcile(a.id);
    assert.equal(service.get(a.id).status,'completed');assert.equal(service.get(a.id).receipt.amountCc,'1.0000000001');
    assert.equal(service.list('nova').length,0);
  } finally {service.close();}
});
test('lost offer and acceptance responses survive restart without replacement transfers',async()=>{
  const f=fixture(),create=f.deps.create,accept=f.deps.accept;
  f.deps.create=async(...args)=>{await create(...args);throw new Error('Response lost');};
  let service=new WalletFunding(f.directory,f.deps);const row=await service.offer('atlas','1','native-response-loss');service.close();
  service=new WalletFunding(f.directory,f.deps);
  try {
    await service.reconcile(row.id);assert.equal(f.creates,1);
    f.deps.accept=async(...args)=>{await accept(...args);throw new Error('Acceptance response lost');};
    await service.accept(row.id,'atlas');await service.reconcile(row.id);assert.equal(f.accepts,1);assert.equal(service.get(row.id).status,'accepted');
    f.setStatus({status:'completed',transaction_id:'delivery',contract_id:'coin'});await service.reconcile(row.id);assert.equal(service.get(row.id).status,'completed');
  } finally {service.close();}
});
test('404 after observed offer never resubmits; unknown submission retries identical immutable request',async()=>{
  const f=fixture();let service=new WalletFunding(f.directory,f.deps);
  const row=await service.offer('atlas','1','native-404-observed');f.setStatus(null);await service.reconcile(row.id);assert.equal(f.creates,1);assert.equal(service.get(row.id).status,'reconciling');service.close();
  const g=fixture(),create=g.deps.create;g.deps.create=async(...args)=>{await create(...args);g.setStatus(null);throw new Error('Unknown submission');};
  service=new WalletFunding(g.directory,g.deps);
  try {const r=await service.offer('atlas','1','native-404-unknown');await service.reconcile(r.id);assert.equal(g.creates,2);assert.deepEqual(g.requests[0],g.requests[1]);await service.reconcile(r.id);await service.reconcile(r.id);assert.equal(g.creates,3);}finally{service.close();}
});
test('completed wallet status waits for evidence and never resubmits when history disappears',async()=>{
  const f=fixture(),proof=f.deps.evidence;f.deps.evidence=async()=>{throw new Error('Ledger offline');};
  let service=new WalletFunding(f.directory,f.deps);const row=await service.offer('atlas','1','native-proof-recovery');f.setStatus({status:'completed',transaction_id:'delivery',contract_id:'coin'});await service.reconcile(row.id);assert.equal(service.get(row.id).status,'verifying');service.close();
  service=new WalletFunding(f.directory,f.deps);
  try {f.setStatus(null);f.deps.evidence=proof;await service.reconcile(row.id);assert.equal(service.get(row.id).status,'completed');assert.equal(f.creates,1);}finally{service.close();}
});
test('native evidence rejects wrong tracking, coin, recipient, amount, sender, domain and transaction',async()=>{
  const f=fixture(),service=new WalletFunding(f.directory,f.deps);
  try {
    await service.offer('atlas','1','native-proof-integrity');const request=f.requests[0],status={transaction_id:'delivery',contract_id:'coin'};
    assert.equal(fundingReceipt(f.proof('delivery'),binding,request,status).amountCc,'1.00');
    const mutations=[(p:any)=>p.transaction.updateId='wrong',(p:any)=>p.transaction.synchronizerId='wrong',(p:any)=>p.transaction.events[0].ExercisedEvent.exerciseResult.trackingInfo.trackingId='wrong',(p:any)=>p.transaction.events[0].ExercisedEvent.exerciseResult.trackingInfo.sender='wrong',(p:any)=>p.transaction.events[0].ExercisedEvent.exerciseResult.transferResult.createdAmulets[0].value='wrong',(p:any)=>p.transaction.events[1].CreatedEvent.createArgument.owner='wrong',(p:any)=>p.transaction.events[1].CreatedEvent.createArgument.amount.initialAmount='2'];
    for(const mutate of mutations){const p=f.proof('delivery');mutate(p);assert.throws(()=>fundingReceipt(p,binding,request,status));}
  }finally{service.close();}
});
test('invalid amounts, failure, expiry and changed identity fail closed',async()=>{
  const f=fixture(),service=new WalletFunding(f.directory,f.deps);
  try {
    for(const amount of ['0','-1','1e1','100.0000000001','0.00000000001'])await assert.rejects(()=>service.offer('atlas',amount,'native-invalid'));
    assert.equal(f.creates,0);
    const r=await service.offer('atlas','100','native-limits');await assert.rejects(()=>service.offer('atlas','1','native-pending'),/existing transfer/);
    f.setStatus({status:'failed',failure_kind:'withdrawn'});await service.reconcile(r.id);assert.equal(service.get(r.id).status,'failed');
    f.setStatus(null);const second=await service.offer('atlas','1','native-expired');const db=new DatabaseSync(path.join(f.directory,'wallet-funding.sqlite'));db.prepare('UPDATE wallet_funding SET request=?,response=NULL WHERE id=?').run(JSON.stringify({...f.requests[1],expires_at:1}),second.id);db.close();f.setStatus(null);await service.reconcile(second.id);assert.equal(f.creates,2);
    f.deps.binding=async()=>({...binding,domain:'changed'});await service.reconcile(second.id);assert.match(service.get(second.id).error!,/Synchronizer changed/);assert.equal(f.creates,2);
  }finally{service.close();}
});
test('empty treasury and cumulative native spending limit reject before external submission',async()=>{
  const f=fixture(),service=new WalletFunding(f.directory,f.deps);
  try {
    f.deps.binding=async()=>({...binding,sender:{...binding.sender,balanceCc:'0.0000000000'}});
    await assert.rejects(()=>service.offer('atlas','1','empty-native-wallet'),/no unlocked/);assert.equal(service.list().length,0);
    f.deps.binding=async()=>structuredClone(binding);
    const row=await service.offer('atlas','100','native-cap-seed');
    const db=new DatabaseSync(path.join(f.directory,'wallet-funding.sqlite'));
    db.prepare("UPDATE wallet_funding SET status='completed' WHERE id=?").run(row.id);
    for(let i=0;i<9;i++)db.prepare('INSERT INTO wallet_funding(id,tenant,requestKey,amount,binding,request,status,createdAt) SELECT ?,tenant,?,amount,binding,request,status,createdAt FROM wallet_funding WHERE id=?').run('cap-'+i,'cap-key-'+i,row.id);
    db.close();await assert.rejects(()=>service.offer('atlas','0.0000000001','native-cap-exceeded'),/1000 CC/);assert.equal(f.creates,1);assert.equal(service.list().length,10);
  }finally{service.close();}
});
test('funding API restricts spending to operator, consent to recipient and hides other tenant history',async t=>{
  const f=fixture(),funding=new WalletFunding(f.directory,f.deps),store=new Store(':memory:');
  const identities=new IdentityStore(':memory:');
  const keys:Record<string,string>={};
  for(const role of ['operator','atlas','nova'] as const){identities.createAccount({id:role+'-owner',name:role,...(role==='operator'?{role:'operator' as const,tenantId:null}:{role:'customer' as const,tenantId:role})});keys[role]=identities.issueKey(role+'-owner').token;}
  const app=createApp(store,undefined,undefined,undefined,undefined,undefined,{mode:'required',identities},undefined,funding);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No port');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));funding.close();store.close();identities.close();});
  const call=(role:string,route='',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/wallet-funding${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${keys[role] || 'invalid'}`,'x-demo-session':'operator','content-type':'application/json','idempotency-key':'native-http-request'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.equal((await call('anonymous')).status,401);
  assert.equal((await call('atlas','',{tenantId:'atlas',amountCc:'1'})).status,403);
  assert.equal((await call('operator','',{tenantId:'atlas',amountCc:'1',receiver:'evil'})).status,400);
  const r=await (await call('operator','',{tenantId:'atlas',amountCc:'1'})).json();const id=r.result.id;
  assert.equal((await call('operator',`/${id}/accept`,{})).status,403);assert.equal((await call('nova',`/${id}/accept`,{})).status,404);assert.equal((await call('nova',`/${id}/reconcile`,{})).status,404);
  const customer=await (await call('atlas')).json();assert.equal(customer.wallets[0].treasury,undefined);assert.equal((await (await call('nova')).json()).transfers.length,0);
  assert.equal((await call('atlas',`/${id}/accept`,{})).status,200);assert.equal(f.accepts,1);
});
