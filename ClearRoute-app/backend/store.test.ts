import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { Localnet } from './localnet.js';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Store, PERIOD } from './store.js';
import { createDemoApp as createApp } from './test-app.js';
import { decimal, format, price } from './money.js';
import { WalletTrafficAdapter } from './wallet-adapter.js';
import http from 'node:http';
const START=Date.parse('2026-09-29T12:00:00Z');
function networkFixture() {
  const directory=mkdtempSync(path.join(os.tmpdir(),'clearroute-localnet-'));
  writeFileSync(path.join(directory,'localnet.json'),JSON.stringify(Object.fromEntries(['provider','atlas','nova'].map(name=>[name,{user:name,party:`${name}::local`}]))));
  return directory;
}
test('uncertain ledger outcome blocks resubmission and survives restart',async()=>{
  const directory=networkFixture();let calls=0;
  let network=new Localnet(directory,async()=>{calls++;throw new Error('Connection dropped after submission');});
  const result=await network.run('atlas','uncertain-request');
  assert.equal(result.status,'needs_reconciliation');assert.equal(calls,1);
  assert.ok(JSON.parse(result.intent).request.commands.commandId);
  assert.deepEqual(await network.run('atlas','uncertain-request'),result);assert.equal(calls,1);
  await assert.rejects(()=>network.run('atlas','another-request'),/Reconcile/);
  assert.equal(network.list('nova').length,0);network.close();
  network=new Localnet(directory,async()=>{throw new Error('Should not submit');});
  assert.equal((await network.run('atlas','uncertain-request')).status,'needs_reconciliation');
  await assert.rejects(()=>network.run('atlas','after-restart'),/Reconcile/);network.close();
});
test('LocalNet HTTP endpoint rejects cross-customer writes and hides other evidence',async()=>{
  const f=fixture();const network=new Localnet(networkFixture(),async()=>({offset:1}));
  const server=createApp(f.store,undefined,network).listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address || typeof address==='string')throw new Error('No port');
  const url=`http://127.0.0.1:${address.port}`;
  try {
    const headers={'x-demo-session':'atlas','content-type':'application/json','idempotency-key':'isolation-request'};
    assert.equal((await fetch(url+'/api/localnet/runs',{method:'POST',headers,body:JSON.stringify({tenantId:'nova'})})).status,403);
    assert.equal(network.list().length,0);
    const state=await (await fetch(url+'/api/localnet',{headers})).json() as any;
    assert.deepEqual(Object.keys(state.identities),['atlas']);
    assert.equal((await fetch(url+'/api/localnet')).status,401);
    assert.equal((await fetch(url+'/api/localnet',{headers:{...headers,origin:'https://outside.example'}})).status,403);
  } finally {await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));network.close();f.store.close();}
});
function fixture(){const store=new Store(':memory:',START);return {store,operator:store.session('operator'),atlas:store.session('atlas'),nova:store.session('nova')};}
function activate(f:ReturnType<typeof fixture>,limit='25'){const req=f.store.request(f.atlas,{tenantId:'atlas',mode:'managed',limitUsd:limit});f.store.approve(f.operator,req.id,limit);}

test('monetary arithmetic is exact and rejects ambiguous inputs',()=>{
  assert.equal(decimal('0.12345678',8),12345678n);assert.equal(format(price(10000000n),6),'0.02');
  for(const bad of ['-1','1e3','0','NaN','1.123456789'])assert.throws(()=>decimal(bad,8));
});
test('customer identity scopes records and hides provider reserves',()=>{
  const f=fixture();assert.throws(()=>f.store.authorize(f.atlas,'nova'),/cannot access/);assert.throws(()=>f.store.operator(f.atlas),/operator/);
  const state=f.store.state(f.atlas);assert.deepEqual(state.tenants.map(t=>t.id),['atlas']);assert.equal(state.treasury,null);f.store.close();
});
test('replayed operation cannot double-fund or double-bill',()=>{
  const f=fixture();activate(f);const input={tenantId:'atlas',trafficBytes:10000,description:'Test action'};
  const first=f.store.mutation(f.atlas,'retry','usage',input,()=>f.store.usage(f.atlas,input));const before=f.store.state(f.operator);
  assert.deepEqual(f.store.mutation(f.atlas,'retry','usage',input,()=>f.store.usage(f.atlas,input)),first);
  assert.deepEqual(f.store.state(f.operator),before);
  assert.throws(()=>f.store.mutation(f.atlas,'retry','usage',{...input,trafficBytes:1},()=>null),/different action/);f.store.close();
});
test('failure rolls back spending and leaves key available for a safe retry',()=>{
  const f=fixture();const before=f.store.state(f.operator);
  assert.throws(()=>f.store.mutation(f.operator,'rollback','test',{},()=>{f.store.fund(10000);throw new Error('failure');}));
  assert.deepEqual(f.store.state(f.operator),before);assert.equal(f.store.mutation(f.operator,'rollback','test',{},()=>({ok:true})).ok,true);f.store.close();
});
test('account limit includes unbilled topups and rejects excess usage atomically',()=>{
  const f=fixture();activate(f,'1');f.store.mutation(f.atlas,'top','top',{},()=>f.store.topup(f.atlas,{tenantId:'atlas',ccAmount:'4',quoteId:f.store.quote().id}));
  const before=f.store.state(f.operator);
  assert.throws(()=>f.store.mutation(f.atlas,'use','use',{},()=>f.store.usage(f.atlas,{tenantId:'atlas',trafficBytes:100000,description:'Too large'})),/account limit/);
  assert.deepEqual(f.store.state(f.operator),before);f.store.close();
});
test('direct token topup does not buy traffic; an expired quote is rejected',()=>{
  const f=fixture();const quote=f.store.quote();f.store.topup(f.atlas,{tenantId:'atlas',ccAmount:'2',quoteId:quote.id});
  assert.equal(f.store.state(f.operator).treasury?.trafficBytes,0);f.store.setMeta('clock',String(START+300000));
  assert.throws(()=>f.store.topup(f.atlas,{tenantId:'atlas',ccAmount:'2',quoteId:quote.id}),/quote expired/);f.store.close();
});
test('15-day windows are half-open and invoice replay does not issue twice',()=>{
  const f=fixture();activate(f);const input={tenantId:'atlas',trafficBytes:1000,description:'Before cutoff'};f.store.usage(f.atlas,input);
  assert.throws(()=>f.store.closePeriod(f.operator,'atlas'),/still open/);f.store.setMeta('clock',String(START+PERIOD));f.store.usage(f.atlas,{...input,description:'At cutoff'});
  const invoice=f.store.mutation(f.operator,'invoice','close',{},()=>f.store.closePeriod(f.operator,'atlas'));
  assert.equal(invoice.totalUsd,'0.004');assert.equal(f.store.state(f.atlas).invoices[0].lines.length,1);assert.equal(f.store.state(f.atlas).tenants[0].unbilledUsd,'0.004');
  assert.equal(f.store.mutation(f.operator,'invoice','close',{},()=>f.store.closePeriod(f.operator,'atlas')).id,invoice.id);
  assert.throws(()=>f.store.closePeriod(f.operator,'atlas'),/still open/);f.store.close();
});
test('partial payments reconcile without overpayment or duplicate reference',()=>{
  const f=fixture();activate(f);f.store.usage(f.atlas,{tenantId:'atlas',trafficBytes:10000,description:'Business workflow'});f.store.setMeta('clock',String(START+PERIOD));
  const invoice=f.store.closePeriod(f.operator,'atlas');const payment={amountUsd:'0.02',rail:'USD',reference:'sim-payment-1'};
  assert.throws(()=>f.store.payment(f.atlas,invoice.id,payment),/operator/);f.store.payment(f.operator,invoice.id,payment);
  assert.equal(f.store.state(f.atlas).invoices[0].status,'partially_paid');assert.throws(()=>f.store.payment(f.operator,invoice.id,payment),/already reconciled/);
  assert.throws(()=>f.store.payment(f.operator,invoice.id,{...payment,amountUsd:'1',reference:'sim-payment-2'}),/exceeds/);
  f.store.payment(f.operator,invoice.id,{...payment,reference:'sim-payment-2'});assert.equal(f.store.state(f.atlas).invoices[0].status,'paid');assert.equal(f.store.exposure('atlas').total,0n);f.store.close();
});
test('records and idempotency survive a database restart',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'lf-test-'));const file=path.join(dir,'test.sqlite');let store=new Store(file,START);
  const result=store.mutation(store.session('atlas'),'persist','top',{},()=>store.topup(store.session('atlas'),{tenantId:'atlas',ccAmount:'1',quoteId:store.quote().id}));store.close();
  store=new Store(file,START+1000);assert.equal(store.mutation(store.session('atlas'),'persist','top',{},()=>{throw new Error('must not rerun');}).reference,result.reference);assert.equal(store.state(store.session('atlas')).topups.length,1);store.close();
});
test('HTTP enforces identity, tenant authorization, origins and amount schema',async()=>{
  const f=fixture();const server=createApp(f.store).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No port');const url=`http://127.0.0.1:${address.port}`;
  try{
    assert.equal((await fetch(`${url}/api/state`)).status,401);const headers={'content-type':'application/json','x-demo-session':'atlas','idempotency-key':'api-test'};
    assert.equal((await fetch(`${url}/api/topups`,{method:'POST',headers,body:JSON.stringify({tenantId:'nova',ccAmount:'2',quoteId:f.store.quote().id})})).status,403);
    assert.equal((await fetch(`${url}/api/state`,{headers:{...headers,origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(`${url}/api/usage`,{method:'POST',headers,body:JSON.stringify({tenantId:'atlas',description:'Bad',trafficBytes:-1})})).status,400);
  }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));f.store.close();}
});
test('wallet adapter preserves documented methods and restricts destinations',async()=>{
  const calls:{method:string;url:string}[]=[];const server=http.createServer(async(req,res)=>{for await(const _ of req){}calls.push({method:req.method!,url:req.url!});res.setHeader('Content-Type','application/json');res.end('{"status":"created"}');}).listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('No port');
  try{
    const adapter=new WalletTrafficAdapter(`http://127.0.0.1:${address.port}/api/validator/`,async()=>'fixture-token',new Set(['domain|receiver']),true);
    const request={receiving_validator_party_id:'receiver',domain_id:'domain',traffic_amount:200000,tracking_id:'persisted-id',expires_at:Date.now()*1000+60000000};await adapter.create(request);await adapter.status(request.tracking_id);
    assert.deepEqual(calls,[{method:'POST',url:'/api/validator/v0/wallet/buy-traffic-requests'},{method:'POST',url:'/api/validator/v0/wallet/buy-traffic-requests/persisted-id/status'}]);
    await assert.rejects(()=>adapter.create({...request,receiving_validator_party_id:'wrong'}),/not approved/);assert.equal(calls.length,2);
  }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
