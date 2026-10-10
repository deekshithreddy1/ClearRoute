import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialBroker } from './oidc.js';

const mapping = [{ id: 'fixture', tokenUrl: 'https://identity.example/token', clientId: 'fixture-app', expectedSubject: 'fixture-user', audience: 'fixture-ledger', grant: 'refresh_token', refreshTokenEnv: 'FIXTURE_REFRESH', tokenEnvs: ['FIXTURE_LEDGER', 'FIXTURE_WALLET'] }];
function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clearroute-oidc-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'renewal.enc.json');
  const env = { CLEARROUTE_TOKEN_STORE_KEY: randomBytes(32).toString('base64'), FIXTURE_REFRESH: 'initial-fixture-refresh' };
  let now = Date.parse('2026-10-10T12:00:00Z');
  const calls: URLSearchParams[] = [];
  const token = (sub = 'fixture-user') => ['fixture', Buffer.from(JSON.stringify({ sub, aud: 'fixture-ledger', exp: Math.floor(now / 1000) + 120 })).toString('base64url'), 'fixture-signature'].join('.');
  const success = (sub = 'fixture-user') => Response.json({ access_token: token(sub), expires_in: 120, token_type: 'Bearer', refresh_token: 'rotated-fixture-refresh' });
  let respond: () => Promise<Response> = async () => success();
  const transport = (async (_url: unknown, init: RequestInit) => { calls.push(new URLSearchParams(String(init.body))); return respond(); }) as typeof fetch;
  const open = () => new CredentialBroker(mapping, file, env, transport, () => now);
  return { open, file, calls, success, advance: (ms: number) => { now += ms; }, respond: (fn: typeof respond) => { respond = fn; } };
}

test('renewal shares one request across wallet/ledger and persists rotation across restart without plaintext', async t => {
  const f = fixture(t), broker = f.open();
  const [ledger, wallet] = await Promise.all([broker.get('FIXTURE_LEDGER'), broker.get('FIXTURE_WALLET')]);
  assert.equal(ledger, wallet); assert.equal(f.calls.length, 1);
  assert.doesNotMatch(readFileSync(f.file, 'utf8'), /initial-fixture-refresh|rotated-fixture-refresh/);
  await f.open().get('FIXTURE_WALLET');
  assert.equal(f.calls[1].get('refresh_token'), 'rotated-fixture-refresh');
  assert.equal(broker.status('FIXTURE_WALLET').status, 'ready');
});

test('temporary renewal failure keeps a valid token, respects retry delay, then recovers', async t => {
  const f = fixture(t), broker = f.open(), original = await broker.get('FIXTURE_WALLET');
  f.advance(61000); f.respond(async () => new Response('', { status: 503 }));
  assert.equal(await broker.get('FIXTURE_WALLET'), original);
  assert.equal(broker.status('FIXTURE_WALLET').status, 'renewal_unavailable');
  assert.equal(await broker.get('FIXTURE_LEDGER'), original); assert.equal(f.calls.length, 2);
  f.advance(30000); f.respond(async () => f.success());
  assert.notEqual(await broker.get('FIXTURE_WALLET'), original);
  assert.equal(broker.status('FIXTURE_WALLET').status, 'ready');
});

test('transport failure never serves an expired token or a token within the safety margin', async t => {
  const f = fixture(t), broker = f.open(), original = await broker.get('FIXTURE_WALLET');
  f.advance(61000); f.respond(async () => { throw new Error('fixture transport error'); });
  assert.equal(await broker.get('FIXTURE_WALLET'), original);
  f.advance(54000);
  await assert.rejects(() => broker.get('FIXTURE_WALLET'), /authentication needs attention/);
  f.advance(6000);
  await assert.rejects(() => broker.get('FIXTURE_WALLET'), /authentication needs attention/);
});

test('revoked refresh credentials block fallback and further renewal attempts', async t => {
  const f = fixture(t), broker = f.open(); await broker.get('FIXTURE_WALLET');
  f.advance(61000); f.respond(async () => new Response('sensitive fixture error', { status: 400 }));
  await assert.rejects(() => broker.get('FIXTURE_WALLET'), e => !String(e).includes('sensitive fixture'));
  assert.equal(broker.status('FIXTURE_WALLET').status, 'reauthorization_required');
  await assert.rejects(() => broker.get('FIXTURE_LEDGER'));
  assert.equal(f.calls.length, 2);
});

test('identity mismatch blocks fallback even while the original token is unexpired', async t => {
  const f = fixture(t), broker = f.open(); await broker.get('FIXTURE_WALLET');
  f.advance(61000); f.respond(async () => f.success('different-user'));
  await assert.rejects(() => broker.get('FIXTURE_WALLET'));
  assert.equal(broker.status('FIXTURE_WALLET').status, 'invalid_token_response');
  await assert.rejects(() => broker.get('FIXTURE_LEDGER')); assert.equal(f.calls.length, 2);
});
