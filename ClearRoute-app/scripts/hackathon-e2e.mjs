import process from 'node:process';

const base = process.env.CLEARROUTE_BASE_URL ?? 'http://127.0.0.1:3002';
const operatorKey = process.env.CLEARROUTE_OPERATOR_KEY;
const customerKey = process.env.CLEARROUTE_CUSTOMER_KEY;
if (!operatorKey || !customerKey) throw new Error('Set CLEARROUTE_OPERATOR_KEY and CLEARROUTE_CUSTOMER_KEY.');
const call = async (route, key, options = {}) => {
  const response = await fetch(`${base}${route}`, { ...options, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(options.headers ?? {}) } });
  const text = await response.text(); let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${route} failed (${response.status}): ${typeof body === 'string' ? body : body?.error?.message ?? JSON.stringify(body)}`);
  return body;
};
const status = await call('/api/auth/session', operatorKey);
if (status.networkMode !== 'localnet') throw new Error(`Server reports network=${status.networkMode}; set CLEARROUTE_NETWORK_MODE=localnet.`);
const localnet = await call('/api/localnet', operatorKey);
if (!localnet.connected) throw new Error(`Canton is not connected: ${localnet.detail}`);
const traffic = await call('/api/traffic', operatorKey);
if (traffic.error || !traffic.target) throw new Error(`Provider wallet is not ready: ${traffic.error ?? 'no traffic target'}`);
const policy = await call('/api/sponsorship/policies/atlas', operatorKey, { method: 'POST', body: JSON.stringify({ enabled: true, batchBytes: traffic.target.minBytes, capacityLimitBytes: traffic.target.minBytes }) });
const request = await call('/api/sponsorship/requests', customerKey, { method: 'POST', headers: { 'idempotency-key': `hackathon-${Date.now()}` }, body: JSON.stringify({ tenantId: 'atlas' }) });
let result = request.result;
for (let attempt = 0; attempt < 24 && !['completed', 'funding_failed'].includes(result.status); attempt++) {
  await new Promise(resolve => setTimeout(resolve, 5000));
  result = (await call(`/api/sponsorship/requests/${encodeURIComponent(result.id)}/reconcile`, customerKey, { method: 'POST', body: '{}' })).result;
  console.log(`attempt=${attempt + 1} status=${result.status}`);
}
if (result.status !== 'completed') throw new Error(`Sponsorship did not complete: ${JSON.stringify(result)}`);
const evidence = await call('/api/localnet', customerKey);
if (!evidence.runs.some(run => run.status === 'completed' && run.tenant === 'atlas')) throw new Error('Completed sponsorship has no completed Atlas ledger workflow.');
console.log(JSON.stringify({ ok: true, policyRevision: policy.policies.find(p => p.tenant === 'atlas')?.revision, requestId: result.id, purchaseId: result.purchase?.id, measurement: result.measurement, ledgerStatus: 'completed' }, null, 2));
