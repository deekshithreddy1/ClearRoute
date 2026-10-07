import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.js';
import { IdentityStore } from './auth.js';
import { Store } from './store.js';
import { Operations } from './operations.js';
import { runtimeConfig } from './config.js';

test('hosted HTTP requires identity, blocks all legacy mutations and isolates customers from planning', async t => {
  const ids = new IdentityStore(':memory:'), store = new Store(':memory:'), ops = new Operations(':memory:', {});
  ids.createAccount({ id: 'admin', name: 'Admin', role: 'operator', tenantId: null });
  ids.createAccount({ id: 'new-company-user', name: 'New company', role: 'customer', tenantId: 'new-company' });
  const admin = ids.issueKey('admin'), customer = ids.issueKey('new-company-user');
  const server = createApp(store, undefined, undefined, undefined, undefined, undefined, { identities: ids, networkMode: 'devnet', secureCookies: true, origins: ['https://app.example.com'] }, undefined, undefined, ops).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); ids.close(); store.close(); ops.close(); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const health = await fetch('http://127.0.0.1:' + address.port + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: 'clearroute', status: 'ok' });
  const call = (route: string, token?: string, body?: unknown) => fetch('http://127.0.0.1:' + address.port + '/api' + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('/operations/devnet')).status, 401);
  for (const route of ['/state', '/localnet', '/wallet-funding', '/sponsorship']) assert.equal((await call(route, admin.token)).status, 410);
  const result = await call('/operations/devnet', customer.token);
  assert.equal(result.status, 200); assert.equal((await result.json()).analytics, null);
  assert.match(result.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal((await call('/operations/devnet/planner', customer.token, { growthPercent: 20, reserveDays: 30, leadDays: 7, minimumCc: '0' })).status, 403);
  assert.equal((await call('/operations/localnet', admin.token)).status, 400);
  assert.equal((await call('/operations/devnet/planner', admin.token, { growthPercent: -1 })).status, 400);
  assert.equal((await call('/operations/devnet/check', admin.token, {})).status, 503);
});

test('hosted runtime rejects missing TLS origin and demo authentication', () => {
  assert.throws(() => runtimeConfig({ CLEARROUTE_NETWORK_MODE: 'devnet' }), /HTTPS/);
  assert.throws(() => runtimeConfig({ CLEARROUTE_NETWORK_MODE: 'mainnet', CLEARROUTE_AUTH_MODE: 'demo', CLEARROUTE_PUBLIC_ORIGIN: 'https://app.example.com' }), /authentication/);
  assert.equal(runtimeConfig({ CLEARROUTE_NETWORK_MODE: 'testnet', CLEARROUTE_PUBLIC_ORIGIN: 'https://app.example.com' }).secureCookies, true);
});
