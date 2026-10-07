import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IdentityStore } from './auth.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { runtimeConfig } from './config.js';

function accounts(ids: IdentityStore) {
  ids.createAccount({ id: 'operator-admin', name: 'Administrator', role: 'operator', tenantId: null });
  ids.createAccount({ id: 'atlas-owner', name: 'Atlas owner', role: 'customer', tenantId: 'atlas' });
  return { operator: ids.issueKey('operator-admin'), atlas: ids.issueKey('atlas-owner') };
}
async function fixture(t: TestContext) {
  const ids = new IdentityStore(':memory:'); const keys = accounts(ids); const store = new Store(':memory:');
  const server = createApp(store, undefined, undefined, undefined, undefined, undefined, { identities: ids }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); ids.close(); store.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const call = (route: string, headers: Record<string, string> = {}, body?: object) => fetch(`http://127.0.0.1:${address.port}/api${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { ids, keys, store, call };
}

test('required authentication rejects forged roles and enforces tenant and operator permissions', async t => {
  const { call, keys } = await fixture(t);
  assert.equal((await call('/state', { 'x-demo-session': 'operator' })).status, 401);
  const headers = { authorization: `Bearer ${keys.atlas.token}`, 'x-demo-session': 'operator', 'idempotency-key': 'auth-tenant-test' };
  const state = await (await call('/state', headers)).json();
  assert.deepEqual(state.tenants.map((tenant: { id: string }) => tenant.id), ['atlas']);
  assert.equal((await call('/clock/advance', headers, { days: 15 })).status, 403);
  assert.equal((await call('/requests', headers, { tenantId: 'nova', mode: 'managed', limitUsd: '10' })).status, 403);
  assert.equal((await call('/requests', headers, { tenantId: 'atlas', mode: 'managed', limitUsd: '10' })).status, 200);
  assert.equal((await call('/clock/advance', { authorization: `Bearer ${keys.operator.token}`, 'idempotency-key': 'auth-clock-test' }, { days: 15 })).status, 200);
});

test('browser sessions have protected cookies, CSRF checks, strict credential precedence and logout', async t => {
  const { call, keys } = await fixture(t);
  assert.equal((await call('/auth/login', {}, { accessKey: keys.atlas.token })).status, 403);
  assert.equal((await call('/auth/login', { origin: 'https://untrusted.example' }, { accessKey: keys.atlas.token })).status, 403);
  const login = await call('/auth/login', { origin: 'http://localhost:3001' }, { accessKey: keys.atlas.token });
  assert.equal(login.status, 200);
  const header = login.headers.get('set-cookie')!;
  assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Path=\/api/);
  assert.ok(!JSON.stringify(await login.json()).includes(keys.atlas.token));
  const cookie = header.split(';')[0];
  assert.equal((await call('/state', { cookie })).status, 200);
  assert.equal((await call('/state', { cookie, authorization: 'Bearer forged' })).status, 401);
  assert.equal((await call('/state', { cookie: `${cookie}; ${cookie}` })).status, 401);
  assert.equal((await call('/auth/logout', { cookie }, {})).status, 403);
  assert.equal((await call('/auth/logout', { cookie, origin: 'http://localhost:3001' }, {})).status, 204);
  assert.equal((await call('/state', { cookie })).status, 401);
});

test('login throttles invalid credentials and returns no secret material', async t => {
  const { call } = await fixture(t);
  for (let i = 0; i < 10; i++) assert.equal((await call('/auth/login', { origin: 'http://localhost:3001' }, { accessKey: 'invalid' })).status, 401);
  const blocked = await call('/auth/login', { origin: 'http://localhost:3001' }, { accessKey: 'invalid' });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('expired keys and sessions fail at the boundary; revocation persists across restart', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clearroute-auth-'));
  const file = path.join(directory, 'identities.sqlite'); let now = Date.now();
  let ids = new IdentityStore(file, () => now);
  t.after(() => { ids.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = accounts(ids); const login = ids.login(keys.atlas.token);
  now = login.expiresAt; assert.throws(() => ids.authenticateSession(login.session), /Sign in/);
  assert.equal(ids.authenticateKey(keys.atlas.token).id, 'atlas-owner');
  const renewed = ids.login(keys.atlas.token); ids.revokeKey(keys.atlas.id);
  ids.close(); ids = new IdentityStore(file, () => now);
  assert.throws(() => ids.authenticateKey(keys.atlas.token)); assert.throws(() => ids.authenticateSession(renewed.session));
  now = keys.operator.expiresAt; assert.throws(() => ids.authenticateKey(keys.operator.token));
  assert.ok(!readFileSync(file).includes(Buffer.from(keys.atlas.token)));
  assert.ok(!readFileSync(file).includes(Buffer.from(login.session)));
});

test('disabled accounts invalidate credentials and sessions; session count is bounded', () => {
  const ids = new IdentityStore(':memory:');
  try {
    const keys = accounts(ids); const oldest = ids.login(keys.atlas.token);
    for (let i = 0; i < 10; i++) ids.login(keys.atlas.token);
    assert.throws(() => ids.authenticateSession(oldest.session));
    const current = ids.login(keys.atlas.token); ids.disableAccount('atlas-owner');
    assert.throws(() => ids.authenticateSession(current.session)); assert.throws(() => ids.authenticateKey(keys.atlas.token)); assert.throws(() => ids.issueKey('atlas-owner'));
    assert.throws(() => ids.createAccount({ id: 'bad-role', name: 'Bad', role: 'customer', tenantId: 'INVALID TENANT' }));
    assert.equal(ids.listAccounts().length, 2);
  } finally { ids.close(); }
});

test('runtime defaults to offline authenticated operation and rejects invalid configuration', () => {
  const config = runtimeConfig({}); assert.equal(config.networkMode, 'offline'); assert.equal(config.mode, 'required');
  for (const env of [{ CLEARROUTE_NETWORK_MODE: 'live' }, { CLEARROUTE_AUTH_MODE: 'off' }, { PORT: 'NaN' }]) assert.throws(() => runtimeConfig(env));
  assert.equal(runtimeConfig({ CLEARROUTE_AUTH_MODE: 'demo' }).mode, 'demo');
});

test('offline authenticated APIs expose no live connectors', async t => {
  const { call, keys } = await fixture(t);
  for (const route of ['/localnet', '/traffic', '/sponsorship', '/metering', '/billing']) assert.equal((await call(route, { authorization: `Bearer ${keys.operator.token}` })).status, 503);
  const status = await (await call('/auth/session')).json();
  assert.deepEqual(status, { mode: 'required', networkMode: 'offline', principal: null });
});
