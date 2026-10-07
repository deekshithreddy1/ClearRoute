import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sponsorConnector } from './sponsor-connector.js';

test('connector verifies customer and validator hosting and scoped customer rights before approval', async t => {
  const directory=mkdtempSync(path.join(tmpdir(),'binding-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  writeFileSync(path.join(directory,'localnet.json'),JSON.stringify({atlas:{party:'atlas::party',user:'atlas'}}));
  let local=true, rights=true;
  const connector=sponsorConnector(directory,{purchase:async()=>null,reconcile:async()=>{},get:()=>null},{run:async()=>undefined},{sync:async()=>{},measurementForRun:()=>({complete:false,bytes:0,chargeUsd:'0.00',updateIds:[]})},{
    trafficTarget:async()=>({party:'validator',domain:'domain',minBytes:200000,balanceCc:'10',checkedAt:''}),
    ledger:async(_user,route)=>route.endsWith('/rights')?{rights:rights?[{kind:{CanActAs:{value:{party:'atlas::party'}}}}]:[]}:{partyDetails:[{party:decodeURIComponent(route.split('/').at(-1)!),isLocal:local}]},
  });
  assert.deepEqual(await connector.binding('atlas'),{party:'atlas::party',user:'atlas',validator:'validator',domain:'domain'});
  local=false;await assert.rejects(()=>connector.binding('atlas'),/hosted/);
  local=true;rights=false;await assert.rejects(()=>connector.binding('atlas'),/actAs/);
});
