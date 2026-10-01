import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Traffic, trafficReceipt, type TrafficDependencies, type TrafficTarget } from './traffic.js';
import { WalletApiError } from './wallet-adapter.js';
import { createApp } from './app.js';
import { Store } from './store.js';

const target:TrafficTarget={party:'provider::local',domain:'domain::local',minBytes:200000,balanceCc:'10.0000000000',checkedAt:new Date().toISOString()};
function fixture(){
 const directory=mkdtempSync(path.join(tmpdir(),'clearroute-traffic-'));
 let status:any=null,creates=0,loseResponse=false;
 const requests:any[]=[];
 const deps:TrafficDependencies={target:async()=>target,adapter:()=>({create:async r=>{creates++;requests.push({...r});status={status:'created'};if(loseResponse)throw new Error('Response lost');return {request_contract_id:'request-contract'};},status:async()=>{if(!status)throw new WalletApiError(404,'Not yet found');return status;}}),evidence:async id=>({transaction:{updateId:id,events:[{ExercisedEvent:{choice:'BuyTrafficRequest_Complete',exerciseResult:{trackingInfo:{trackingId:requests[0].tracking_id},purchasedTraffic:'traffic-contract'}}},{ExercisedEvent:{choice:'AmuletRules_BuyMemberTraffic',choiceArgument:{provider:target.party,synchronizerId:target.domain,trafficAmount:String(requests[0].traffic_amount),memberId:'member'},exerciseResult:{purchasedTraffic:'traffic-contract',amuletPaid:'666.8000000000',summary:{amuletPrice:'0.0050000000'},meta:{values:{'splice.lfdecentralizedtrust.org/burned':'666.8'}}}}}]}})};
 return {directory,deps,requests,get creates(){return creates;},setStatus(value:any){status=value;},lose(){loseResponse=true;}};
}
test('traffic request is durable; duplicate clicks reuse it; amount changes conflict',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{
  const [a,b]=await Promise.all([service.purchase(200000,'duplicate-key'),service.purchase(200000,'duplicate-key')]);
  assert.equal(a.id,b.id);assert.equal(f.creates,1);assert.equal(service.list().length,1);
  await assert.rejects(()=>service.purchase(400000,'duplicate-key'),/different amount/);
  await assert.rejects(()=>service.purchase(200000,'another-key'),/existing traffic purchase/);
  f.setStatus({status:'completed',transaction_id:'verified-transaction'});await service.reconcile(a.id);
  assert.equal(service.list()[0].status,'completed');assert.equal(service.list()[0].evidence.transaction.updateId,'verified-transaction');
 }finally{service.close();}
});
test('lost create response recovers after restart without a second purchase',async()=>{
 const f=fixture();f.lose();let service=new Traffic(f.directory,f.deps);
 const result=await service.purchase(200000,'lost-response-key');assert.equal(result.status,'reconciling');service.close();
 f.setStatus({status:'completed',transaction_id:'completed-on-network'});service=new Traffic(f.directory,f.deps);
 try{await service.reconcile(result.id);assert.equal(service.list()[0].status,'completed');assert.equal(f.creates,1);}finally{service.close();}
});
test('404 recovery resubmits identical tracking ID and expiry, never a new purchase',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{const r=await service.purchase(200000,'retry-same-request');f.setStatus(null);await service.reconcile(r.id);assert.equal(f.creates,2);assert.deepEqual(f.requests[0],f.requests[1]);}finally{service.close();}
});
test('network rejects insufficient funds; rejection is terminal and never confirmed',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{const r=await service.purchase(200000,'insufficient-funds');f.setStatus({status:'failed',failure_reason:'rejected',rejection_reason:'Insufficient funds'});await service.reconcile(r.id);assert.equal(service.list()[0].status,'failed');await service.reconcile(r.id);assert.equal(f.creates,1);assert.equal(service.list()[0].evidence,null);}finally{service.close();}
});
test('empty wallet, sub-minimum, fractional and oversized quantities cannot submit',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{for(const bytes of [0,-1,1.5,100000,1000001])await assert.rejects(()=>service.purchase(bytes,'invalid-quantity'));assert.equal(f.creates,0);f.deps.target=async()=>({...target,balanceCc:'0.0000000000'});await assert.rejects(()=>service.purchase(200000,'empty-wallet-key'),/no unlocked/);assert.equal(service.list().length,0);}finally{service.close();}
});
test('expired unknown request and changed network identities never trigger a new submission',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{const r=await service.purchase(200000,'expired-request');f.setStatus(null);const db=new DatabaseSync(path.join(f.directory,'traffic.sqlite'));db.prepare('UPDATE purchases SET request=? WHERE id=?').run(JSON.stringify({...r.request,expires_at:Date.now()*1000-1}),r.id);db.close();await service.reconcile(r.id);assert.equal(f.creates,1);assert.equal(service.list()[0].status,'reconciling');f.deps.target=async()=>({...target,domain:'changed'});await service.reconcile(r.id);assert.equal(f.creates,1);}finally{service.close();}
});
test('unrecognized completion response cannot become confirmed',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{const r=await service.purchase(200000,'invalid-status-key');f.setStatus({status:'completed'});await service.reconcile(r.id);assert.equal(service.list()[0].status,'reconciling');}finally{service.close();}
});
test('traffic API is operator-only and rejects unapproved destinations',async()=>{
 const f=fixture(),traffic=new Traffic(f.directory,f.deps),store=new Store(':memory:');
 const server=createApp(store,undefined,undefined,traffic).listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();if(!address||typeof address==='string')throw new Error('No port');const url=`http://127.0.0.1:${address.port}/api/traffic`;
 try{
  for(const role of ['atlas','nova']){const headers={'x-demo-session':role,'content-type':'application/json','idempotency-key':'unauthorized-key'};assert.equal((await fetch(url,{headers})).status,403);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({bytes:200000})})).status,403);assert.equal((await fetch(url+'/fake/reconcile',{method:'POST',headers,body:'{}'})).status,403);}
  const headers={'x-demo-session':'operator','content-type':'application/json','idempotency-key':'invalid-destination'};
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({bytes:200000,domain_id:'other-network'})})).status,400);assert.equal(f.creates,0);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));traffic.close();store.close();}
});
test('receipt verification rejects another tracking ID, destination, or amount',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{
  const row=await service.purchase(200000,'receipt-integrity');const evidence=await f.deps.evidence('tx',target.party);
  assert.equal(trafficReceipt(evidence,row.request).burnedCc,'666.8');
  for(const changed of [{...row.request,traffic_amount:300000},{...row.request,domain_id:'wrong'},{...row.request,tracking_id:'wrong'}])assert.throws(()=>trafficReceipt(evidence,changed));
 }finally{service.close();}
});
test('wallet-confirmed purchase stays completed while missing ledger evidence recovers',async()=>{
 const f=fixture();const goodEvidence=f.deps.evidence;f.deps.evidence=async()=>{throw new Error('Ledger unavailable');};let service=new Traffic(f.directory,f.deps);
 const row=await service.purchase(200000,'evidence-recovery');f.setStatus({status:'completed',transaction_id:'confirmed-tx'});await service.reconcile(row.id);
 assert.equal(service.list()[0].status,'completed');assert.equal(service.list()[0].evidence,null);service.close();
 f.setStatus(null);f.deps.evidence=goodEvidence;service=new Traffic(f.directory,f.deps);
 try{await service.reconcile(row.id);assert.equal(service.list()[0].status,'completed');assert.ok(service.list()[0].evidence.purchase);assert.equal(f.creates,1);}finally{service.close();}
});
test('local cumulative purchase cap is enforced before network submission',async()=>{
 const f=fixture(),service=new Traffic(f.directory,f.deps);
 try{const r=await service.purchase(1000000,'cap-seed-request');f.setStatus({status:'completed',transaction_id:'cap-tx'});await service.reconcile(r.id);
 const db=new DatabaseSync(path.join(f.directory,'traffic.sqlite'));db.prepare('UPDATE purchases SET bytes=10000000 WHERE id=?').run(r.id);db.close();
 await assert.rejects(()=>service.purchase(200000,'cap-excess-request'),/limit has been reached/);assert.equal(f.creates,1);
 }finally{service.close();}
});
