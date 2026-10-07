import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {Metering,BILLING_PERIOD,periodFor} from './metering.js';
import {Store} from './store.js';
import {createDemoApp as createApp} from './test-app.js';
function fixture(){
 const directory=mkdtempSync(path.join(tmpdir(),'metering-'));
 const config=Object.fromEntries(['provider','atlas','nova'].map(actor=>[actor,{user:actor,party:actor+'::party'}]));writeFileSync(path.join(directory,'localnet.json'),JSON.stringify(config));
 const commands=new Map<string,{actor:string;tenant:string;name:string;runId:string}>();const completions:any[]=[];let mismatch=false;
 function add(actor:string,offset:number,bytes:number|null=100,code=0,time='2026-09-30T00:00:00.000123Z') {const commandId=actor+'-'+offset;commands.set(commandId,{actor,tenant:actor==='provider'?'atlas':actor,name:'Submission',runId:'run'});completions.push({commandId,userId:actor,actAs:[actor+'::party'],offset,paidTrafficCost:bytes,status:{code},updateId:'tx-'+offset,synchronizerTime:{synchronizerId:'domain',recordTime:time}});}
 const call:any=async(user:string,route:string,body:any)=>{if(route.includes('command-completions'))return completions.filter(c=>c.userId===user&&c.offset>body.beginExclusive).map(c=>({completionResponse:{Completion:{value:c}}}));const c=completions.find(c=>c.updateId===body.updateId);return {transaction:{commandId:c.commandId,updateId:c.updateId,offset:c.offset,paidTrafficCost:mismatch?999:c.paidTrafficCost,synchronizerId:c.synchronizerTime.synchronizerId,recordTime:c.synchronizerTime.recordTime}};};
 return {directory,commands,completions,add,call,setMismatch(v:boolean){mismatch=v;},open(){return new Metering(directory,()=>commands,call);}};
}
test('measured bytes survive replay and restart; overhead, failure and absent measurements are excluded',async()=>{
 const f=fixture();f.add('atlas',1);f.add('provider',2,200);f.add('atlas',3,50,8);f.add('atlas',4,null);f.add('nova',5,300);let m=f.open();await m.sync();await m.sync();assert.equal(m.state().rows.length,5);assert.equal(m.state('atlas').rows.length,3);assert.ok(m.state('atlas').rows.every(r=>r.actor==='atlas'));const start=Date.parse(m.state('atlas').periods.atlas[0]);const inv=m.invoice('atlas',start);assert.equal(inv.totalUsd,'0.0004');assert.equal(inv.lines.length,1);assert.equal(inv.payable,false);m.close();m=f.open();try{await m.sync();assert.deepEqual(m.invoice('atlas',start),inv);assert.equal(m.state().rows.length,5);}finally{m.close();}
});
test('transaction mismatch waits for evidence; fifteen-day boundary and immutable late snapshots',async()=>{
 const f=fixture();f.add('atlas',1);f.setMismatch(true);const m=f.open();try{await m.sync();assert.equal(m.state('atlas').rows[0].status,'pending_evidence');f.setMismatch(false);await m.sync();const start=Date.parse(m.state('atlas').periods.atlas[0]);const first=m.invoice('atlas',start);f.add('atlas',2,200,0,'2026-10-15T00:00:00.000001Z');f.add('atlas',3,20,0,'2026-10-14T23:59:59.999999Z');await m.sync();const updated=m.invoice('atlas',start);assert.equal(updated.lines.length,2);assert.notEqual(first.id,updated.id);assert.equal(m.state().invoices.length,2);assert.equal(m.invoice('atlas',start+BILLING_PERIOD).lines.length,1);assert.equal(periodFor(start+BILLING_PERIOD,start),start+BILLING_PERIOD);}finally{m.close();}
});
test('multi-party completion halts cursor; no false attribution',async()=>{const f=fixture();f.add('atlas',1);f.completions[0].actAs.push('nova::party');const m=f.open();try{await m.sync();assert.equal(m.state().rows.length,0);assert.match(String(m.state('atlas').cursors[0].error),/multi-party/);assert.equal(m.state('atlas').cursors[0].offset,0);}finally{m.close();}});

test('isolated runtime data uses the configured external identities for metering',async()=>{
 const f=fixture();f.add('atlas',1);const runtime=mkdtempSync(path.join(tmpdir(),'metering-runtime-'));
 const m=new Metering(runtime,()=>f.commands,f.call,path.join(f.directory,'localnet.json'));
 try{await m.sync();assert.equal(m.state('atlas').rows.length,1);assert.equal(m.state('atlas').rows[0].status,'verified');assert.equal(m.state('nova').rows.length,0);}finally{m.close();}
});
test('metered finalization rejects stale previews and unresolved evidence then freezes exactly reviewed usage',async()=>{
 const f=fixture();f.add('atlas',1);const m=f.open();try{await m.sync();const start=m.state('atlas').periods.atlas[0],first=m.invoice('atlas',Date.parse(start));while(m.billing.now()<Date.parse(first.periodEnd))m.billing.advance();f.add('atlas',2);await m.sync();assert.throws(()=>m.billing.mutate('stale-preview-key','finalize',{},()=>m.finalize('atlas',start,first.id)),/Measurements changed/);const latest=m.invoice('atlas',Date.parse(start));f.add('atlas',3);f.setMismatch(true);await m.sync();assert.throws(()=>m.billing.mutate('pending-preview-key','finalize',{},()=>m.finalize('atlas',start,latest.id)),/unresolved/);f.setMismatch(false);await m.sync();const final=m.invoice('atlas',Date.parse(start));const issued=m.billing.mutate('valid-finalize-key','finalize',{},()=>m.finalize('atlas',start,final.id));assert.equal(issued.lines.length,3);assert.equal(issued.totalUsd,final.totalUsd);assert.equal(issued.payable,false);}finally{m.close();}
});
test('metering API scopes customers and restricts synchronization and previews to operator',async()=>{
 const f=fixture();f.add('atlas',1);f.add('nova',2);const m=f.open();await m.sync();const store=new Store(path.join(f.directory,'store.sqlite'));const server=createApp(store,undefined,undefined,undefined,m).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as any).port}/api/metering`;
 try{const result=await fetch(base,{headers:{'x-demo-session':'atlas'}});const data=await result.json();assert.ok(data.rows.every((r:any)=>r.actor==='atlas'));assert.equal(data.periods.nova,undefined);for(const route of ['/sync','/invoices']){const r=await fetch(base+route,{method:'POST',headers:{'x-demo-session':'atlas','content-type':'application/json'},body:'{}'});assert.equal(r.status,403);}}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));m.close();store.close();}
});
