import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Operations, fixed, display } from './operations.js';
import { profileSchema } from './networks.js';
import { templateId, type Template } from './contracts.js';
import { hostedLedger } from './hosted-ledger.js';
import type { Session } from './store.js';

const op: Session = { id: 'operator', role: 'operator', tenantId: null };
const alice: Session = { id: 'alice-user', role: 'customer', tenantId: 'alice' };
const bob: Session = { id: 'bob-user', role: 'customer', tenantId: 'bob' };
const profile = profileSchema.parse({
  ledgerUrl: 'https://ledger.example.com', participantId: 'participant::test', synchronizerId: 'synchronizer::test', packageId: 'a'.repeat(64), writesEnabled: true,
  provider: { userId: 'provider', partyId: 'provider::test', tokenEnv: 'PROVIDER_TOKEN' },
  customers: { alice: { name: 'Alice', userId: 'alice', partyId: 'alice::test', tokenEnv: 'ALICE_TOKEN' }, bob: { name: 'Bob', userId: 'bob', partyId: 'bob::test-party', tokenEnv: 'BOB_TOKEN' } },
});
const offer = { action: 'offer', tenantId: 'alice', agreementId: 'agreement-1', mode: 'ManagedUsage', termsRef: 'terms-v1', pricingPolicyVersion: 'pricing-v1', exposureLimitUsd: '100', maxAllowanceUnits: '100', validUntil: '2027-01-01T00:00:00Z', acceptBefore: '2026-11-01T00:00:00Z' };
function fixture() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'clearroute-operations-')), 'ops.sqlite');
  let now = Date.parse('2026-10-06T12:00:00Z'), lost = false, offset = 0;
  const calls: any[] = [], transactions = new Map<string, any>();
  const event = (template: Template, payload: any, id = randomUUID()) => ({ CreatedEvent: { contractId: id, templateId: templateId(template, profile.packageId), createArgument: { provider: profile.provider.partyId, customer: profile.customers.alice.partyId, network: 'DevNet', ...payload } } });
  const tx = (events: any[], at = new Date(now).toISOString(), commandId = '') => { const value = { updateId: 'update-' + ++offset, offset, recordTime: at, synchronizerId: profile.synchronizerId, commandId, events }; transactions.set(value.updateId, value); return value; };
  const call = async (_p: any, identity: any, route: string, body?: any) => {
    calls.push({ identity, route, body });
    if (route.endsWith('/participant-id')) return { participantId: profile.participantId };
    if (route === '/v2/packages') return { packageIds: [profile.packageId] };
    if (route.endsWith('/ledger-end')) return { offset };
    if (route === '/v2/updates/update-by-id') return { update: { Transaction: { value: transactions.get(body.updateId) } } };
    if (route.endsWith('/submit-and-wait-for-transaction')) {
      const c = body.commands.commands[0];
      const value = tx(c.CreateCommand ? [event('ServiceOffer', c.CreateCommand.createArguments)] : [], undefined, body.commands.commandId);
      if (lost) throw new Error('lost response');
      return { transaction: value };
    }
    throw new Error('Unexpected route ' + route);
  };
  const open = () => new Operations(file, { devnet: profile }, call, () => now);
  const service = open();
  const approve = () => service.policy('devnet', 'alice', op, { status: 'approved', limitUsd: '100', maxAllowanceUnits: '100', note: 'Reviewed account' });
  return { service, open, event, tx, calls, transactions, approve, lose() { lost = true; }, advance(ms: number) { now += ms; }, now: () => now };
}

test('profiles reject loopback, plaintext, shared identities and malformed tenant bindings', () => {
  for (const ledgerUrl of ['http://ledger.example.com', 'https://localhost', 'https://user:secret@example.com', 'https://example.com/path']) assert.throws(() => profileSchema.parse({ ...profile, ledgerUrl }));
  assert.throws(() => profileSchema.parse({ ...profile, customers: { alice: { ...profile.customers.alice, tokenEnv: 'PROVIDER_TOKEN' } } }));
  assert.throws(() => profileSchema.parse({ ...profile, customers: { INVALID: profile.customers.alice } }));
  assert.equal(display(fixed('9007199254740993.0000000001') + fixed('0.0000000009')), '9007199254740993.000000001');
  for (const value of ['-1', '1e3', '0.00000000001', 'NaN']) assert.throws(() => fixed(value));
});

test('hosted transport sends scoped secrets only to the configured origin and sanitizes errors', async () => {
  let options: RequestInit | undefined;
  const call = hostedLedger({ PROVIDER_TOKEN: 'secret-token' }, (async (url, init) => { assert.equal(url, 'https://ledger.example.com/v2/packages'); options = init; return Response.json({ packageIds: [] }); }) as typeof fetch);
  await call(profile, profile.provider, '/v2/packages');
  assert.equal(options?.redirect, 'error'); assert.equal((options?.headers as any).authorization, 'Bearer secret-token');
  await assert.rejects(() => call(profile, profile.customers.alice, '/v2/packages'), /credential/);
  await assert.rejects(() => call(profile, profile.provider, '/v2/../outside'), /Unsupported/);
  const bad = hostedLedger({ PROVIDER_TOKEN: 'secret-token' }, (async () => new Response('secret-token', { status: 401 })) as typeof fetch);
  await assert.rejects(() => bad(profile, profile.provider, '/v2/packages'), error => !String(error).includes('secret-token'));
});

test('customer requests are tenant isolated, durable, bounded, and review never executes funding', () => {
  const f = fixture();
  try {
    const input = { key: randomUUID(), mode: 'DirectTopUp', amount: '1.0000000001', reason: 'Fund the next batch' };
    const a = f.service.request('devnet', alice, input) as any;
    assert.equal((f.service.request('devnet', alice, input) as any).id, a.id);
    assert.throws(() => f.service.request('devnet', alice, { ...input, amount: '2' }), /different/);
    assert.throws(() => f.service.request('devnet', alice, { ...input, key: randomUUID() }), /existing request/);
    assert.equal(f.service.state('devnet', bob).requests.length, 0);
    assert.throws(() => f.service.reviewRequest('devnet', alice, a.id, { status: 'approved', note: 'Review' }), /Operator/);
    f.service.reviewRequest('devnet', op, a.id, { status: 'approved', note: 'Reviewed destination' });
    assert.equal(f.service.state('devnet', alice).accounts[0].status, 'pending');
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.service.reviewRequest('devnet', op, a.id, { status: 'rejected', note: 'Review again' }), /already/);
  } finally { f.service.close(); }
  const reopened = f.open(); try { assert.equal(reopened.state('devnet', alice).requests[0].status, 'approved'); } finally { reopened.close(); }
});

test('commands require approved policies, scoped consent, fresh health and durable idempotency', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => f.service.submit('devnet', op, 'offer-key', offer), /connection check/);
    await f.service.health('devnet', op);
    await assert.rejects(() => f.service.submit('devnet', op, 'offer-key', offer), /approved/);
    f.approve();
    await assert.rejects(() => f.service.submit('devnet', alice, 'offer-key', offer), /Operator/);
    await assert.rejects(() => f.service.submit('devnet', op, 'offer-key', { ...offer, exposureLimitUsd: '101' }), /exceeds/);
    const a = await f.service.submit('devnet', op, 'offer-key', offer);
    assert.equal(a.status, 'confirmed');
    assert.deepEqual(await f.service.submit('devnet', op, 'offer-key', offer), a);
    assert.equal(f.calls.filter(c => c.route.includes('submit-and')).length, 1);
    const body = f.calls.at(-1).body;
    assert.equal(body.commands.commands[0].CreateCommand.templateId, templateId('ServiceOffer', profile.packageId));
    assert.deepEqual(body.commands.actAs, [profile.provider.partyId]);
    await assert.rejects(() => f.service.submit('devnet', op, 'offer-key', { ...offer, agreementId: 'changed' }), /different/);
    const contractId = f.service.state('devnet', alice).contracts[0].id;
    await assert.rejects(() => f.service.submit('devnet', bob, 'accept-key', { action: 'accept', contractId }), /customer must/);
    await assert.rejects(() => f.service.submit('devnet', op, 'accept-key', { action: 'accept', contractId }), /customer must/);
    assert.equal(f.service.state('devnet', bob).contracts.length, 0);
    assert.equal(f.service.state('devnet', alice).analytics, null);
    assert.equal(JSON.stringify(f.service.state('devnet', op)).includes('TOKEN'), false);
    f.advance(300001);
    await assert.rejects(() => f.service.submit('devnet', op, 'fresh-key', { ...offer, agreementId: 'new' }), /connection check/);
  } finally { f.service.close(); }
});

test('lost responses survive restart and reconcile by original identity without resubmission', async () => {
  const f = fixture(); f.approve(); await f.service.health('devnet', op); f.lose();
  const a = await f.service.submit('devnet', op, 'uncertain-key', offer);
  assert.equal(a.status, 'uncertain');
  await assert.rejects(() => f.service.submit('devnet', op, 'second-key', { ...offer, agreementId: 'new' }), /pending command/);
  f.service.close();
  const reopened = f.open();
  try {
    assert.equal((await reopened.submit('devnet', op, 'uncertain-key', offer)).status, 'uncertain');
    await reopened.reconcile('devnet', op, 'update-1', a.id);
    assert.equal((await reopened.submit('devnet', op, 'uncertain-key', offer)).status, 'confirmed');
    assert.equal(f.calls.filter(c => c.route.includes('submit-and')).length, 1);
    assert.ok(f.calls.at(-1).body.updateFormat.includeTransactions);
  } finally { reopened.close(); }
});

test('evidence is atomic, ordered, network bound and replays cannot inflate sales', async () => {
  const f = fixture();
  try {
    const invoice = { invoiceId: 'invoice-a', paidUsd: '0', lines: [{ fixedUsd: '12.0000000001' }] };
    const a = f.tx([f.event('Invoice', invoice)], '2026-09-01T00:00:00Z');
    await f.service.reconcile('devnet', op, a.updateId);
    await f.service.reconcile('devnet', op, a.updateId);
    const b = f.tx([f.event('Invoice', { ...invoice, paidUsd: '1' })], '2026-10-01T00:00:00Z');
    await f.service.reconcile('devnet', op, b.updateId);
    assert.equal(f.service.analytics('devnet').monthly.at(-2)?.invoicedUsd, '12.0000000001');
    assert.equal(f.service.analytics('devnet').monthly.at(-1)?.invoicedUsd, '0.00');
    const bad = f.tx([f.event('PaymentReceipt', { paymentRef: 'p', settledUsd: '1' }), f.event('Invoice', { ...invoice, lines: [{ fixedUsd: '13' }] })]);
    await assert.rejects(() => f.service.reconcile('devnet', op, bad.updateId), /conflicting/);
    assert.equal(f.service.analytics('devnet').monthly.at(-1)?.collectedUsd, '0.00');
    bad.synchronizerId = 'wrong';
    await assert.rejects(() => f.service.reconcile('devnet', op, bad.updateId), /synchronizer/);
    assert.equal(f.service.state('testnet', op).contracts.length, 0);
    await assert.rejects(() => f.service.reconcile('devnet', alice, a.updateId), /Operator/);
  } finally { f.service.close(); }
});

test('procurement uses three closed months, separates CC transfers, and fails closed for stale observations', async () => {
  const f = fixture();
  try {
    assert.equal(f.service.analytics('devnet').forecast.suggestedPurchaseCc, null);
    for (const month of ['07', '08', '09']) {
      const tx = f.tx([f.event('FundingReceipt', { nativePurchaseRef: month, actualCcBurned: '20' }), f.event('TopUpReceipt', { nativeTransferRef: month, recipientCc: '10' })], '2026-' + month + '-15T00:00:00Z');
      await f.service.reconcile('devnet', op, tx.updateId);
    }
    f.service.treasury('devnet', op, { balanceCc: '10', observedAt: new Date(f.now()).toISOString(), evidenceRef: 'statement-1', note: 'Reviewed wallet' });
    const result = f.service.analytics('devnet');
    assert.equal(result.forecast.baselineCc, '30.00'); assert.equal(result.forecast.nextMonthCc, '36.00');
    assert.equal(result.forecast.targetCc, '80.40'); assert.equal(result.forecast.suggestedPurchaseCc, '70.40');
    assert.equal(result.monthly.at(-2)?.burnedCc, '20.00'); assert.equal(result.monthly.at(-2)?.transferredCc, '10.00');
    assert.equal(result.growthPercent, null);
    assert.throws(() => f.service.planner('devnet', alice, { growthPercent: 20, reserveDays: 30, leadDays: 7, minimumCc: '0' }), /Operator/);
    f.advance(86400001);
    assert.equal(f.service.analytics('devnet').forecast.suggestedPurchaseCc, null);
    assert.equal(f.service.analytics('devnet').treasury?.stale, true);
  } finally { f.service.close(); }
});

test('CC recipients persist, remain tenant scoped, and cannot change on request replay', () => {
  const f = fixture();
  const input = { key: randomUUID(), mode: 'DirectTopUp', amount: '1.0000000001', reason: 'Devnet testing', recipient: { company: 'Alice startup', email: 'alice@example.com', partyId: 'alice::treasury', validator: 'NODERS', ownershipReference: 'review-ticket-1' } };
  try {
    const request = f.service.request('devnet', alice, input) as any;
    assert.equal((f.service.request('devnet', alice, input) as any).id, request.id);
    assert.throws(() => f.service.request('devnet', alice, { ...input, recipient: { ...input.recipient, partyId: 'other::treasury' } }), /Recipient changed/);
    assert.throws(() => f.service.request('devnet', bob, { ...input, recipient: { ...input.recipient, email: 'invalid' } }));
    assert.equal(f.service.state('devnet', bob).recipients.length, 0);
    assert.throws(() => f.service.reviewRequest('devnet', alice, request.id, { status: 'approved', note: 'self approval' }), /Operator/);
    f.service.reviewRequest('devnet', op, request.id, { status: 'approved', note: 'Ownership review pending before transfer' });
    assert.equal(f.calls.length, 0);
    const reopened = f.open();
    try { assert.equal(reopened.state('devnet', alice).recipients[0].partyId, input.recipient.partyId); assert.equal(reopened.state('devnet', alice).capabilities.nativeTransfers, false); } finally { reopened.close(); }
  } finally { f.service.close(); }
});
