import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ledger } from '../dist-backend/localnet-client.js';
const headers={'x-demo-session':'atlas','Content-Type':'application/json','idempotency-key':'integration-atlas-001'};
async function api(route,body) {
  const response=await fetch('http://127.0.0.1:3001'+route,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
}
  const state=await api('/api/localnet');
  assert.equal(state.connected,true,state.detail);
  assert.deepEqual(Object.keys(state.identities),['atlas']);
  const result=(await api('/api/localnet/runs',{tenantId:'atlas'})).result;
  assert.equal(result.status,'completed',result.error);
  assert.equal(result.steps.length,5);
  const replay=(await api('/api/localnet/runs',{tenantId:'atlas'})).result;
  assert.deepEqual(replay,result);
  const config=JSON.parse(readFileSync('data/localnet.json','utf8'));
  for (const step of result.steps) {
    const verified=await ledger(config.atlas.user,'/v2/updates/transaction-by-id',{updateId:step.updateId,requestingParties:[config.atlas.party]});
    assert.equal(verified.transaction.updateId,step.updateId);
  }
  await assert.rejects(()=>ledger(config.nova.user,'/v2/updates/transaction-by-id',{updateId:result.steps[4].updateId,requestingParties:[config.nova.party]}),/Ledger 404/);
  mkdirSync('evidence',{recursive:true});
  writeFileSync('evidence/localnet-atlas.json',JSON.stringify({verifiedAt:new Date().toISOString(),checks:['five actual transactions re-read from Canton','same-key replay unchanged','Nova cannot read Atlas completion'],result},null,2)+'\n');
  console.log('PASS: five real transactions verified, replay unchanged, and ledger-enforced customer isolation.');
