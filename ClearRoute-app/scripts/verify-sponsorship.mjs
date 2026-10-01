import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';

if (!process.argv.includes('--execute')) throw new Error('Use --execute after component verification. This buys 200,000 bytes with LocalNet test CC and executes an Atlas workflow.');
async function api(route, body, role = 'operator', key = 'acceptance-sponsored-atlas-v1') {
  const response = await fetch('http://127.0.0.1:3001/api/sponsorship' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-demo-session': role, 'content-type': 'application/json', 'idempotency-key': key }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
const state = await api('');
if (!state.policies.some(p => p.tenant === 'atlas')) await api('/policies/atlas', { enabled: true, batchBytes: 200000, capacityLimitBytes: 200000 });
else {
  const policy = state.policies.find(p => p.tenant === 'atlas');
  assert.equal(policy.batchBytes, 200000, 'Existing policy uses a different batch; review it before this acceptance test.');
}
let { result } = await api('/requests', { tenantId: 'atlas' }, 'atlas');
mkdirSync('evidence', { recursive: true });
const save = () => writeFileSync('evidence/sponsorship-atlas.json', JSON.stringify({ verifiedAt: new Date().toISOString(), result }, null, 2) + '\n');
save();
const deadline = Date.now() + 300000;
while (!['completed', 'funding_failed', 'needs_reconciliation'].includes(result.status) && Date.now() < deadline) {
  console.log(result.status + ': ' + (result.error || result.id));
  await new Promise(resolve => setTimeout(resolve, 5000));
  ({ result } = await api(`/requests/${result.id}/reconcile`, {}, 'atlas')); save();
}
assert.equal(result.status, 'completed', result.error || 'Sponsorship did not complete before the deadline. The saved request is retained for recovery.');
assert.equal(result.purchase.bytes, 200000);
assert.ok(result.purchase.evidence.purchase.burnedCc);
assert.equal(result.run.steps.length, 5);
assert.ok(result.measurement.complete);
assert.equal(result.measurement.updateIds.length, 2);
const receiptTime = Date.parse(result.purchase.evidence.purchase.recordTime);
assert.ok(Number.isFinite(receiptTime));
for (const step of result.run.steps) assert.ok(Date.parse(step.recordTime) >= receiptTime, 'Workflow preceded the verified funding receipt.');
const replay = (await api('/requests', { tenantId: 'atlas' }, 'atlas')).result;
assert.deepEqual(replay, result, 'Same-key replay changed the completed request.');
const other = await api('', undefined, 'nova'); assert.ok(other.requests.every(r => r.tenant === 'nova'));
console.log(`PASS: ${result.id}; verified traffic purchase → five ledger transactions → ${result.measurement.bytes} measured customer bytes; replay and tenant isolation verified.`);
