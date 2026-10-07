import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { IdentityStore } from './auth.js';
import { OnboardingStore } from './onboarding.js';
import { Store } from './store.js';
import { createApp } from './app.js';

const party = (prefix:string) => `${prefix}::${'a'.repeat(64)}`;
async function fixture(t:TestContext){
  const ids=new IdentityStore(':memory:'); ids.createAccount({id:'operator-admin',name:'Operator',role:'operator',tenantId:null}); ids.createAccount({id:'atlas-owner',name:'Atlas',role:'customer',tenantId:'atlas'});
  const operator=ids.issueKey('operator-admin'), customer=ids.issueKey('atlas-owner'); const registry=new OnboardingStore(':memory:'); const store=new Store(':memory:');
  const server=createApp(store,undefined,undefined,undefined,undefined,undefined,{identities:ids},registry).listen(0,'127.0.0.1'); await once(server,'listening'); const address=server.address(); if(!address||typeof address==='string')throw new Error('No port');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));registry.close();ids.close();store.close();});
  const call=(route:string,key:string,body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',origin:'http://localhost:3001'},body:body===undefined?undefined:JSON.stringify(body)});
  return {call,operator:operator.token,customer:customer.token,registry};
}

test('application and validator onboarding requires independent approval before binding',async t=>{
  const {call,operator,customer}=await fixture(t);
  assert.equal((await call('/onboarding/applications',customer,{id:'atlas-app',name:'Atlas application',tenantId:'atlas',party:party('atlas'),participant:'app-provider'})).status,201);
  assert.equal((await call('/onboarding/validators',operator,{id:'validator-one',name:'Validator One',participant:'validator',domain:'global',partyPrefix:'atlas'})).status,201);
  assert.equal((await call('/onboarding/applications/atlas-app/bind-validator',operator,{validatorId:'validator-one'})).status,409);
  assert.equal((await call('/onboarding/applications/atlas-app/approve',operator,{})).status,200);
  assert.equal((await call('/onboarding/validators/validator-one/approve',operator,{})).status,200);
  const bound=await call('/onboarding/applications/atlas-app/bind-validator',operator,{validatorId:'validator-one'}); assert.equal(bound.status,200); assert.equal((await bound.json()).validatorId,'validator-one');
  const state=await (await call('/onboarding',customer)).json(); assert.equal(state.applications.length,1); assert.equal(state.applications[0].validatorId,'validator-one'); assert.equal(state.validators.length,1);
});

test('customer isolation, operator-only validator registration and malformed identities fail closed',async t=>{
  const {call,operator,customer}=await fixture(t);
  assert.equal((await call('/onboarding/validators',customer,{id:'bad-validator',name:'Bad',participant:'validator',domain:'global',partyPrefix:'atlas'})).status,403);
  assert.equal((await call('/onboarding/applications',customer,{id:'nova-app',name:'Nova application',tenantId:'nova',party:party('nova'),participant:'app-user'})).status,403);
  assert.equal((await call('/onboarding/applications',customer,{id:'bad_app',name:'x',tenantId:'atlas',party:'invalid',participant:'x'})).status,400);
  await call('/onboarding/applications',customer,{id:'atlas-app',name:'Atlas application',tenantId:'atlas',party:party('atlas'),participant:'app-provider'});
  await call('/onboarding/validators',operator,{id:'validator-one',name:'Validator One',participant:'validator',domain:'global',partyPrefix:'nova'});
  await call('/onboarding/applications/atlas-app/approve',operator,{}); await call('/onboarding/validators/validator-one/approve',operator,{});
  assert.equal((await call('/onboarding/applications/atlas-app/bind-validator',operator,{validatorId:'validator-one'})).status,200);
  const visible=await (await call('/onboarding',customer)).json(); assert.equal(visible.validators.length,1); assert.equal(visible.validators[0].partyPrefix,'nova');
});

test('registrations persist and approval is idempotent',()=>{
  const registry=new OnboardingStore(':memory:'); const operator={id:'operator',role:'operator' as const,tenantId:null};
  try { registry.registerApplication(operator,{id:'atlas-app',name:'Atlas application',tenantId:'atlas',party:party('atlas'),participant:'app-provider'}); registry.registerValidator(operator,{id:'validator-one',name:'Validator One',participant:'validator',domain:'global',partyPrefix:'atlas'}); const first=registry.approveApplication(operator,'atlas-app'); const second=registry.approveApplication(operator,'atlas-app'); assert.equal(first.revision,second.revision); registry.approveValidator(operator,'validator-one'); registry.bind(operator,'atlas-app','validator-one'); assert.equal(registry.state(operator).applications[0].validatorId,'validator-one'); } finally {registry.close();}
});
