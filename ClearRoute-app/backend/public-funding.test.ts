import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { PublicFunding } from './public-funding.js';
import { NodersDevnetWallet, DEVNET_DOMAIN, type DevnetWallet, type Offer } from './devnet-wallet.js';
import { createApp } from './app.js';
import { IdentityStore } from './auth.js';
import { Store, type Session } from './store.js';

const admin: Session = { id: 'admin', role: 'operator', tenantId: null };
const customer: Session = { id: 'customer', role: 'customer', tenantId: 'first-customer' };
const party = (name: string) => name + '::1220' + 'a'.repeat(64);
const request = (name = 'receiver') => ({ key: randomBytes(32).toString('base64url'), network: 'devnet', company: 'Test team', email: 'user@example.com', party: party(name), wallet: 'Splice wallet', amount: '1.1234567891', purpose: 'Testing our Canton app', consent: true, acceptsOffers: true });
function fakeWallet() {
  const sent: Offer[] = [];
  let status: 'created' | 'accepted' | 'completed' = 'created';
  const wallet: DevnetWallet = { check: async () => ({ party: party('treasury'), balanceCc: '841.6729090741', checkedAt: new Date().toISOString(), synchronizer: DEVNET_DOMAIN }), create: async offer => { sent.push(offer); return { offer_contract_id: 'offer' }; }, status: async () => ({ status, transaction_id: 'tx-' + status, contract_id: 'contract-' + status }) };
  return { wallet, sent, status: (next: typeof status) => { status = next; } };
}
const approve = (service: PublicFunding, id: string) => service.review(admin, id, { decision: 'approved', note: 'Verified party with the tester', recipientVerified: true });

test('public funding: private receipt, exact CC, approval, recipient acceptance and wallet evidence', async t => {
  const f = fakeWallet(), service = new PublicFunding(':memory:', f.wallet, true); t.after(() => service.close());
  const input = request(), result = service.request(input);
  assert.equal(result.amount, '1.1234567891'); assert.equal(result.status, 'pending');
  assert.equal(service.request(input).id, result.id);
  assert.throws(() => service.request({ ...input, amount: '2' }), /different details/);
  assert.throws(() => service.request({ ...input, key: request().key }), /already has a request/);
  assert.throws(() => service.track({ key: request().key }), /No request/);
  assert.equal(service.track({ key: input.key }).email, undefined);
  assert.equal(service.state(admin).requests[0].email, input.email);
  assert.throws(() => approve(service, 'missing'), /not found/);
  assert.throws(() => service.review(admin, result.id, { decision: 'approved', note: 'Missing verification', recipientVerified: false }), /Confirm/);
  approve(service, result.id);
  const sent = await service.send(admin, result.id);
  assert.equal(sent.status, 'created'); assert.equal(f.sent[0].amount, input.amount); assert.equal(f.sent[0].receiver_party_id, input.party);
  await service.send(admin, result.id); assert.equal(f.sent.length, 1);
  f.status('accepted'); assert.equal((await service.reconcile(admin, result.id)).status, 'accepted');
  f.status('completed'); await service.tick();
  const delivered = service.track({ key: input.key });
  assert.equal(delivered.status, 'completed'); assert.equal(delivered.evidence.transaction_id, 'tx-completed');
  assert.equal(service.state(admin).deliveredCc, input.amount);
  assert.ok(delivered.events.some((e: {kind: string}) => e.kind === 'completed'));
});

test('timeouts and restarts never resubmit; malformed status cannot confirm delivery', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clearroute-public-'));
  const f = fakeWallet(), file = path.join(dir, 'db.sqlite');
  f.wallet.create = async offer => { f.sent.push(offer); throw new Error('secret credential must not appear'); };
  let service = new PublicFunding(file, f.wallet, true); const input = request(), r = service.request(input); approve(service, r.id);
  assert.equal((await service.send(admin, r.id)).status, 'uncertain');
  assert.doesNotMatch(JSON.stringify(service.state(admin)), /secret credential/);
  service.close(); service = new PublicFunding(file, f.wallet, true); t.after(() => { service.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(dir, { recursive: true, force: true }); });
  await service.send(admin, r.id); assert.equal(f.sent.length, 1);
  f.wallet.status = async () => ({ status: 'completed' } as any);
  assert.equal((await service.reconcile(admin, r.id)).status, 'uncertain');
  f.wallet.status = async () => { throw new Error('404'); };
  await service.reconcile(admin, r.id); assert.equal(f.sent.length, 1);
  f.wallet.status = async () => ({ status: 'completed', transaction_id: 'tx', contract_id: 'coin' });
  assert.equal((await service.reconcile(admin, r.id)).status, 'completed');
});

test('financial gates: no customer sends, no Mainnet intake, exact budget and immutable decisions', async t => {
  const f = fakeWallet(), service = new PublicFunding(':memory:', f.wallet, true); t.after(() => service.close());
  assert.throws(() => service.request({ ...request(), network: 'mainnet' }));
  for (const amount of ['0', '-1', '1e2', '10.0000000001', '0.00000000001']) assert.throws(() => service.request({ ...request(), amount }));
  assert.throws(() => service.request({ ...request(), party: '0x123' }));
  assert.throws(() => service.state(customer));
  const r = service.request({ ...request(), amount: '10' });
  await assert.rejects(() => service.send(customer, r.id), /Operator/);
  assert.throws(() => service.review(customer, r.id, { decision: 'approved' }), /Operator/);
  await service.send(admin, r.id); assert.equal(f.sent.length, 0);
  approve(service, r.id);
  assert.throws(() => approve(service, r.id), /already/);
  for (let i = 0; i < 9; i++) approve(service, service.request({ ...request('receiver-' + i), amount: '10' }).id);
  const excess = service.request({ ...request('excess'), amount: '0.0000000001' });
  assert.throws(() => approve(service, excess.id), /budget/);
  assert.equal(service.state(admin).reservedCc, '100.00');
});

test('HTTP public intake is origin limited; operators alone can review; no cross-network funding', async t => {
  const ids = new IdentityStore(':memory:'), store = new Store(':memory:'), f = fakeWallet(), service = new PublicFunding(':memory:', f.wallet, true);
  ids.createAccount({ id: 'admin', name: 'Admin', role: 'operator', tenantId: null });
  ids.createAccount({ id: 'customer', name: 'Customer', role: 'customer', tenantId: 'first-customer' });
  const adminKey = ids.issueKey('admin').token, customerKey = ids.issueKey('customer').token;
  const origin = 'https://demo.example.com';
  const server = createApp(store, undefined, undefined, undefined, undefined, undefined, { identities: ids, networkMode: 'devnet', origins: [origin] }, undefined, undefined, undefined, service).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); service.close(); store.close(); ids.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/`;
  const call = (route: string, body?: unknown, token?: string, from: string = origin) => fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: from, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const input = request();
  assert.equal((await call('public-funding/requests', input, undefined, 'https://evil.example')).status, 403);
  assert.equal((await call('public-funding/requests', input, undefined, '')).status, 403);
  const made = await call('public-funding/requests', input); assert.equal(made.status, 201); const r = await made.json();
  assert.equal((await call('devnet-funding')).status, 401);
  assert.equal((await call('devnet-funding', undefined, customerKey)).status, 403);
  const listing = await call('devnet-funding', undefined, adminKey); assert.equal(listing.status, 200);
  assert.equal((await call('public-funding/track', { key: request().key })).status, 404);
  assert.equal((await call('devnet-funding/' + r.id + '/send', {}, customerKey)).status, 403);
  for (let i = 0; i < 5; i++) await call('public-funding/requests', input);
  assert.equal((await call('public-funding/requests', input)).status, 429);
});

test('NODERS adapter verifies expected party, synchronizer and response schema; redacts upstream errors', async () => {
  let mode = 'ok'; const urls: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    urls.push(String(url)); assert.equal(init?.redirect, 'error');
    if (mode === 'error') return new Response('secret internal diagnostics', { status: 401 });
    const body = String(url).includes('user-status') ? { party_id: party(mode === 'wrong' ? 'other' : 'treasury'), user_onboarded: true, user_wallet_installed: true }
      : String(url).includes('connected-synchronizers') ? { connectedSynchronizers: [{ synchronizerId: mode === 'network' ? 'mainnet' : DEVNET_DOMAIN, permission: 'PARTICIPANT_PERMISSION_SUBMISSION' }] }
      : String(url).includes('transfer-offers') ? { offers: [] } : { effective_unlocked_qty: '100.0000000000' };
    return Response.json(body);
  };
  const adapter = new NodersDevnetWallet(party('treasury'), () => 'test', transport);
  assert.equal((await adapter.check()).balanceCc, '100.0000000000'); assert.equal(urls.length, 4);
  mode = 'wrong'; await assert.rejects(() => adapter.check(), /does not match/);
  mode = 'network'; await assert.rejects(() => adapter.check(), /Devnet synchronizer/);
  mode = 'error'; await assert.rejects(() => adapter.check(), e => e instanceof Error && !e.message.includes('secret') && e.message.includes('401'));
});

test('disabled sends, changed treasury and insufficient balance cannot release funds', async t => {
  const f = fakeWallet(), disabled = new PublicFunding(':memory:', f.wallet, false), service = new PublicFunding(':memory:', f.wallet, true);
  t.after(() => { disabled.close(); service.close(); });
  const off = disabled.request(request()); approve(disabled, off.id);
  await assert.rejects(() => disabled.send(admin, off.id), /disabled/);
  const r = service.request(request()); approve(service, r.id);
  const originalCheck = f.wallet.check;
  f.wallet.check = async () => ({ ...await originalCheck(), balanceCc: '0.00' });
  await assert.rejects(() => service.send(admin, r.id), /Insufficient/); assert.equal(f.sent.length, 0);
  f.wallet.check = originalCheck;
  await Promise.allSettled([service.send(admin, r.id), service.send(admin, r.id)]);
  assert.equal(f.sent.length, 1);
  f.wallet.check = async () => ({ ...await originalCheck(), party: party('different-treasury') });
  await assert.rejects(() => service.reconcile(admin, r.id), /original treasury/);
  f.wallet.check = originalCheck;
  f.wallet.status = async () => ({ status: 'failed', failure_kind: 'expired' });
  assert.equal((await service.reconcile(admin, r.id)).status, 'failed');
  assert.equal(service.state(admin).reservedCc, '0.00');
});

test('public funding cannot be exposed by Mainnet, Testnet, offline or demo-role deployments', async () => {
  for (const networkMode of ['mainnet', 'testnet', 'offline', 'devnet'] as const) {
    const service = new PublicFunding(':memory:'), store = new Store(':memory:');
    const server = createApp(store, undefined, undefined, undefined, undefined, undefined, { networkMode, mode: networkMode === 'devnet' ? 'demo' : 'required' }, undefined, undefined, undefined, service).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/public-funding`);
      assert.equal(response.status, 503);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); service.close(); store.close(); }
  }
});
