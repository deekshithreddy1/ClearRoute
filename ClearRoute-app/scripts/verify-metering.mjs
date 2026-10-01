import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {ledger} from '../dist-server/localnet-client.js';
const base='http://127.0.0.1:3001/api/metering';
async function request(role='operator',route='',body){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'x-demo-session':role,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(r.status,200);return r.json();}
await request('operator','/sync',{});
const state=await request();assert.ok(state.rows.length);assert.ok(state.cursors.every(c=>!c.error));
for(const row of state.rows.filter(r=>['verified','provider_overhead'].includes(r.status))){const {transaction}=await ledger(row.user,'/v2/updates/transaction-by-id',{updateId:row.updateId,requestingParties:[row.party]});assert.equal(transaction.paidTrafficCost,row.bytes);assert.equal(transaction.commandId,row.commandId);assert.equal(transaction.offset,row.offset);}
const invoices=[];
for(const actor of ['atlas','nova']){const own=await request(actor);assert.ok(own.rows.every(r=>r.actor===actor));const periodStart=own.periods[actor][0];assert.ok(periodStart);const invoice=await request('operator','/invoices',{tenantId:actor,periodStart});assert.equal(invoice.payable,false);assert.deepEqual(await request('operator','/invoices',{tenantId:actor,periodStart}),invoice);assert.equal(invoice.lines.length,own.rows.filter(r=>r.status==='verified').length);invoices.push(invoice);}
await request('operator','/sync',{});const after=await request();assert.deepEqual(after.rows.map(r=>r.id),state.rows.map(r=>r.id));
writeFileSync('evidence/metering-verified.json',JSON.stringify({checkedAt:new Date().toISOString(),totals:after.totals,cursors:after.cursors,rows:after.rows,invoices},null,2));
console.log(JSON.stringify({verified:true,totals:after.totals,invoices:invoices.map(i=>({tenant:i.tenant,totalUsd:i.totalUsd,bytes:i.lines.reduce((n,l)=>n+l.bytes,0),payable:i.payable}))},null,2));
