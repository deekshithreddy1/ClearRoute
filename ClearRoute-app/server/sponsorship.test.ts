import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Sponsorship, type SponsorDependencies, type Binding } from './sponsorship.js';
import { createApp } from './app.js';
import { Store } from './store.js';

const approval = { enabled: true, batchBytes: 200000, capacityLimitBytes: 400000 };
function fixture(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'sponsor-test-'));
  let service: Sponsorship;
  let funding = 'completed', evidence = true, measured = true, runStatus = 'completed', losePurchase = false;
  let binding: Binding = { party: 'atlas::party', user: 'atlas', validator: 'validator', domain: 'domain' };
  const purchases = new Map<string, any>(), runs = new Map<string, any>(), order: string[] = [];
  const deps: SponsorDependencies = {
    async binding(tenant) { return { ...binding, party: tenant + '::party', user: tenant }; },
    async purchase(bytes, key) { order.push('purchase'); if (!purchases.has(key)) purchases.set(key, { id: key, bytes, status: funding, target: { party: binding.validator, domain: binding.domain }, evidence: evidence ? { purchase: { burnedCc: '1.00' } } : null }); if (losePurchase) { losePurchase = false; throw new Error('Response lost'); } return purchases.get(key); },
    async reconcilePurchase() {},
    getPurchase(id) { return purchases.get(id); },
    async run(tenant, key) { order.push('run'); if (!runs.has(key)) runs.set(key, { id: key, tenant, status: runStatus, steps: [{ name: 'Customer accepts', updateId: 'tx-1' }, { name: 'Customer submits sample', updateId: 'tx-2' }] }); return runs.get(key); },
    async measure() { order.push('measure'); return { complete: measured, bytes: 6000, chargeUsd: '0.024', updateIds: ['tx-1','tx-2'] }; },
  };
  service = new Sponsorship(directory, deps);
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get service() { return service; }, deps, purchases, runs, order,
    funding(value: string) { funding = value; }, evidence(value: boolean) { evidence = value; }, measured(value: boolean) { measured = value; }, uncertain() { runStatus = 'needs_reconciliation'; }, lose() { losePurchase = true; },
    changeIdentity() { binding = { ...binding, domain: 'different-domain' }; },
    reopen() { service.close(); service = new Sponsorship(directory, deps); },
  };
}

test('unapproved applications cannot spend or submit; invalid policy fails before effects', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.service.submit('atlas', 'request-001'), /approve sponsorship/);
  await assert.rejects(() => f.service.approve('atlas', { ...approval, capacityLimitBytes: 1 }), /200000/);
  assert.equal(f.purchases.size, 0); assert.equal(f.runs.size, 0);
});
test('sponsorship purchases verified capacity before execution and records attributable usage', async t => {
  const f = fixture(t); await f.service.approve('atlas', approval);
  const result = await f.service.submit('atlas', 'request-001');
  assert.equal(result.status, 'completed'); assert.deepEqual(f.order, ['purchase','run','measure']);
  assert.equal(result.measurement?.bytes, 6000); assert.equal(result.purchase.evidence.purchase.burnedCc, '1.00');
  assert.equal(f.service.state('atlas').policies[0].remainingCapacityBytes, 200000);
  assert.ok(f.service.state().audit.some(a => a.kind === 'request.completed'));
});
test('concurrent duplicate requests and restart reuse one purchase and one ledger run', async t => {
  const f = fixture(t); await f.service.approve('atlas', approval);
  const [a,b] = await Promise.all([f.service.submit('atlas','duplicate-key'),f.service.submit('atlas','duplicate-key')]);
  assert.equal(a.id,b.id); assert.equal(f.purchases.size,1); assert.equal(f.runs.size,1);
  f.reopen(); const replay=await f.service.submit('atlas','duplicate-key');
  assert.equal(replay.status,'completed'); assert.equal(f.purchases.size,1); assert.equal(f.runs.size,1);
});
test('pending and completed-without-evidence purchases never execute customer workflow', async t => {
  const f=fixture(t); f.evidence(false); await f.service.approve('atlas',approval);
  const result=await f.service.submit('atlas','missing-receipt'); assert.equal(result.status,'awaiting_funding'); assert.equal(f.runs.size,0);
  await assert.rejects(()=>f.service.submit('atlas','second-request'),/existing sponsorship/);
  const purchase=[...f.purchases.values()][0];purchase.status='pending';purchase.evidence={purchase:{burnedCc:'1'}};
  await f.service.reconcile(result.id);assert.equal(f.runs.size,0);
  purchase.status='completed';await f.service.reconcile(result.id);assert.equal(f.runs.size,1);
});
test('lost purchase response recovers across restart with the same funding key', async t => {
  const f=fixture(t);await f.service.approve('atlas',approval);f.lose();
  const first=await f.service.submit('atlas','lost-response');assert.equal(first.status,'awaiting_funding');assert.equal(f.runs.size,0);
  f.reopen();await f.service.reconcile(first.id);assert.equal(f.service.get(first.id).status,'completed');assert.equal(f.purchases.size,1);
});
test('confirmed funding rejection releases allowance and never submits', async t => {
  const f=fixture(t);f.funding('rejected');await f.service.approve('atlas',{...approval,capacityLimitBytes:200000});
  const result=await f.service.submit('atlas','rejected-request');assert.equal(result.status,'funding_failed');assert.equal(f.runs.size,0);assert.equal(f.service.state().policies[0].remainingCapacityBytes,200000);
});
test('purchased capacity remains charged against allowance after uncertain ledger result', async t => {
  const f=fixture(t);f.uncertain();await f.service.approve('atlas',{...approval,capacityLimitBytes:200000});
  const r=await f.service.submit('atlas','uncertain-ledger');assert.equal(r.status,'needs_reconciliation');
  f.reopen();await f.service.reconcile(r.id);assert.equal(f.purchases.size,1);assert.equal(f.runs.size,1);
  assert.equal(f.service.state().policies[0].remainingCapacityBytes,0);
  await assert.rejects(()=>f.service.submit('atlas','another-request'),/allowance is exhausted/);
});
test('missing measurements hold completion; recovery does not repeat purchase or execution', async t => {
  const f=fixture(t);f.measured(false);await f.service.approve('atlas',approval);
  const r=await f.service.submit('atlas','measure-request');assert.equal(r.status,'awaiting_measurement');assert.equal(r.measurement,null);
  f.measured(true);await f.service.reconcile(r.id);assert.equal(f.service.get(r.id).status,'completed');assert.deepEqual(f.order,['purchase','run','measure','measure']);
});
test('paused approval and network identity change block resumed execution', async t => {
  const f=fixture(t);f.evidence(false);await f.service.approve('atlas',approval);const r=await f.service.submit('atlas','pause-request');
  await f.service.approve('atlas',{...approval,enabled:false});await f.service.reconcile(r.id);assert.match(f.service.get(r.id).error || '',/paused/);assert.equal(f.runs.size,0);
  await f.service.approve('atlas',approval);f.changeIdentity();await f.service.reconcile(r.id);assert.match(f.service.get(r.id).error || '',/identity changed/);assert.equal(f.runs.size,0);
});
test('limits cannot release reserved funding and customer evidence stays isolated', async t => {
  const f=fixture(t);await f.service.approve('atlas',approval);await f.service.submit('atlas','first-request');await f.service.submit('atlas','second-request');
  await assert.rejects(()=>f.service.approve('atlas',{...approval,capacityLimitBytes:200000}),/below purchased or reserved/);
  assert.equal(f.service.state('nova').requests.length,0);assert.equal(f.service.state('nova').audit.length,0);
  assert.throws(()=>f.service.get(f.service.state().requests[0].id,'nova'),/not found/);
});
test('wallet outage or insufficient reserves cannot fall through to ledger execution', async t => {
  const f=fixture(t);await f.service.approve('atlas',approval);
  f.deps.purchase=async()=>{throw new Error('Insufficient unlocked CC');};
  const r=await f.service.submit('atlas','empty-reserve');assert.equal(r.status,'awaiting_funding');assert.match(r.error||'',/Insufficient/);assert.equal(f.runs.size,0);
});
test('pausing approval during an in-flight purchase blocks subsequent ledger submission', async t => {
  const f=fixture(t);await f.service.approve('atlas',approval);
  const buy=f.deps.purchase;f.deps.purchase=async(bytes,key)=>{const receipt=await buy(bytes,key);await f.service.approve('atlas',{...approval,enabled:false});return receipt;};
  const r=await f.service.submit('atlas','pause-during-buy');assert.equal(r.status,'awaiting_ledger');assert.match(r.error||'',/paused/);assert.equal(f.runs.size,0);
});
test('HTTP sponsorship requires operator approval and prevents cross-tenant submission and reconciliation', async t => {
  const f=fixture(t),store=new Store(':memory:');const server=createApp(store,undefined,undefined,undefined,undefined,f.service).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/api/sponsorship`;
  const post=(route:string,body:unknown,role='atlas',key='http-request-key')=>fetch(url+route,{method:'POST',headers:{'x-demo-session':role,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
  assert.equal((await post('/policies/atlas',approval)).status,403);
  assert.equal((await post('/policies/atlas',approval,'operator')).status,200);
  assert.equal((await post('/requests',{tenantId:'nova'})).status,403);
  assert.equal((await post('/requests',{tenantId:'atlas',party:'injected'})).status,400);
  assert.equal((await post('/requests',{tenantId:'atlas'},'atlas','')).status,400);
  const response=await post('/requests',{tenantId:'atlas'});assert.equal(response.status,200);const {result}=await response.json();
  assert.equal((await post(`/requests/${result.id}/reconcile`,{},'nova')).status,404);
  assert.equal((await(await fetch(url,{headers:{'x-demo-session':'nova'}})).json()).requests.length,0);
});
