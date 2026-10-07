import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from './store.js';
import { createDemoApp as createApp } from './test-app.js';

async function fixture(t: TestContext) {
  const store = new Store(':memory:', Date.parse('2026-09-01T00:00:00Z'));
  const server = createApp(store).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  const call = (route: string, body?: string, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${address.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'x-demo-session': 'atlas', 'content-type': 'application/json', 'idempotency-key': 'http-regression', ...extra }, body,
  });
  return { store, call };
}

test('malformed and oversized requests return stable client errors without writes', async t => {
  const { store, call } = await fixture(t);
  const before = store.state(store.session('operator'));
  for (const [body, status, code] of [['{', 400, 'INVALID_JSON'], [JSON.stringify({ description: 'x'.repeat(25000) }), 413, 'PAYLOAD_TOO_LARGE']] as const) {
    const response = await call('/api/usage', body);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.deepEqual(store.state(store.session('operator')), before);
});

test('disabled components and unknown routes return JSON errors', async t => {
  const { call } = await fixture(t);
  for (const route of ['/api/localnet', '/api/traffic', '/api/metering', '/api/billing']) {
    assert.equal((await call(route, undefined, { 'x-demo-session': 'operator' })).status, 503);
  }
  const response = await call('/api/missing');
  assert.equal(response.status, 404); assert.equal((await response.json()).error.code, 'NOT_FOUND');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('HTTP retries are isolated by session and reject changed payloads', async t => {
  const { store, call } = await fixture(t);
  const payload = { tenantId: 'atlas', ccAmount: '1', quoteId: store.quote().id };
  const first = await (await call('/api/topups', JSON.stringify(payload))).json();
  assert.deepEqual(await (await call('/api/topups', JSON.stringify(payload))).json(), first);
  assert.equal((await call('/api/topups', JSON.stringify({ ...payload, ccAmount: '2' }))).status, 409);
  assert.equal((await call('/api/topups', JSON.stringify({ ...payload, tenantId: 'nova' }), { 'x-demo-session': 'nova' })).status, 200);
  assert.equal(store.state(store.session('atlas')).topups.length, 1);
  assert.equal(store.state(store.session('nova')).topups.length, 1);
});

test('invalid role and unexpected input fields fail closed', async t => {
  const { call, store } = await fixture(t);
  assert.equal((await call('/api/state', undefined, { 'x-demo-session': 'admin' })).status, 401);
  assert.equal((await call('/api/topups', JSON.stringify({ tenantId: 'atlas', ccAmount: '1', quoteId: store.quote().id, approved: true }))).status, 400);
  assert.equal(store.state(store.session('atlas')).topups.length, 0);
});
