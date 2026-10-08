import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './money.js';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{2,100}$/);
const httpsUrl = z.string().url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; }, 'Use a clean HTTPS token endpoint.');
const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,50}$/), tokenUrl: httpsUrl, clientId: z.string().min(1).max(200),
  tokenEnvs: z.array(envName).min(1), expectedSubject: z.string().min(1), audience: z.string().min(1),
  grant: z.enum(['refresh_token', 'client_credentials']), refreshTokenEnv: envName.optional(), clientSecretEnv: envName.optional(),
  scope: z.string().max(300).optional(),
}).strict().superRefine((p, ctx) => {
  if (p.grant === 'refresh_token' && !p.refreshTokenEnv) ctx.addIssue({ code: 'custom', message: 'refreshTokenEnv is required.' });
  if (p.grant === 'client_credentials' && !p.clientSecretEnv) ctx.addIssue({ code: 'custom', message: 'clientSecretEnv is required.' });
});
export const oidcConfig = z.array(providerSchema).min(1).max(20).superRefine((ps, ctx) => {
  const names = ps.flatMap(p => p.tokenEnvs);
  if (new Set(names).size !== names.length || new Set(ps.map(p => p.id)).size !== ps.length) ctx.addIssue({ code: 'custom', message: 'Provider IDs and token environment mappings must be unique.' });
});
type Provider = z.infer<typeof providerSchema>;
type Capsule = { iv: string; tag: string; body: string };
type Memory = { token?: string; expiresAt?: number; lastRenewedAt?: number; retryAt?: number; blocked?: boolean; status: string };
const capsuleSchema = z.object({ iv: z.string(), tag: z.string(), body: z.string() }).strict();
const tokenResponse = z.object({ access_token: z.string().min(1).max(30000), expires_in: z.number().positive().max(366 * 86400), refresh_token: z.string().min(1).max(30000).optional(), token_type: z.string().refine(v => v.toLowerCase() === 'bearer') });
const unavailable = () => new AppError('CREDENTIAL_RENEWAL_REQUIRED', 'Wallet authentication needs attention. Check the operator credential status; no payment was retried.', 503);

/** One application replica owns this store. Tokens are never sent to browser clients. */
export class CredentialBroker {
  private saved: Record<string, Capsule> = {};
  private memory = new Map<string, Memory>();
  private flights = new Map<string, Promise<string>>();
  private secret: Buffer;
  readonly providers: Provider[];
  constructor(raw: unknown, private storeFile: string, private env: NodeJS.ProcessEnv = process.env, private transport: typeof fetch = fetch, private now = Date.now) {
    this.providers = oidcConfig.parse(raw);
    const key = env.CLEARROUTE_TOKEN_STORE_KEY ?? '';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error('Renewal requires CLEARROUTE_TOKEN_STORE_KEY: a persistent, secret base64-encoded 32-byte encryption key.');
    this.secret = Buffer.from(key, 'base64');
    if (existsSync(storeFile)) this.saved = z.record(capsuleSchema).parse(JSON.parse(readFileSync(storeFile, 'utf8')));
    for (const p of this.providers) {
      this.memory.set(p.id, { status: 'not_checked' });
      if (this.saved[p.id]) this.decrypt(p); // Wrong keys/configuration fail before any network call.
    }
  }
  private context(p: Provider) { return createHash('sha256').update(JSON.stringify({ tokenUrl: p.tokenUrl, clientId: p.clientId, expectedSubject: p.expectedSubject, audience: p.audience, grant: p.grant })).digest('hex'); }
  private decrypt(p: Provider): string | undefined {
    const record = this.saved[p.id]; if (!record) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.secret, Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from(this.context(p))); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(record.body, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw new Error('Cannot decrypt saved renewal credentials. Restore the original encryption key/configuration or reauthorize using the documented reset procedure.'); }
  }
  private persist(p: Provider, refresh: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secret, iv); cipher.setAAD(Buffer.from(this.context(p)));
    const encrypted = Buffer.concat([cipher.update(refresh, 'utf8'), cipher.final()]);
    const next = { ...this.saved, [p.id]: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: encrypted.toString('base64') } };
    mkdirSync(path.dirname(this.storeFile), { recursive: true, mode: 0o700 });
    const temporary = this.storeFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    try { writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true }); renameSync(temporary, this.storeFile); this.saved = next; }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  has(name: string) { return this.providers.some(p => p.tokenEnvs.includes(name)); }
  expectedSubject(name: string) { return this.providers.find(p => p.tokenEnvs.includes(name))?.expectedSubject; }
  status(name: string) {
    const p = this.providers.find(p => p.tokenEnvs.includes(name));
    if (!p) return { mode: 'manual', status: 'manual_token', expiresAt: null, lastRenewedAt: null };
    const m = this.memory.get(p.id)!;
    return { mode: p.grant, status: m.expiresAt && m.expiresAt <= this.now() && m.status === 'ready' ? 'expired' : m.status, expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null, lastRenewedAt: m.lastRenewedAt ? new Date(m.lastRenewedAt).toISOString() : null };
  }
  async get(name: string): Promise<string | undefined> {
    const p = this.providers.find(p => p.tokenEnvs.includes(name));
    if (!p) return this.env[name];
    const m = this.memory.get(p.id)!;
    if (m.blocked) throw unavailable();
    if (m.token && m.expiresAt! > this.now() + 60000) return m.token;
    if (m.retryAt && m.retryAt > this.now()) throw unavailable();
    let flight = this.flights.get(p.id);
    if (!flight) { flight = this.renew(p).finally(() => this.flights.delete(p.id)); this.flights.set(p.id, flight); }
    return flight;
  }
  private async renew(p: Provider) {
    const m = this.memory.get(p.id)!;
    const form = new URLSearchParams({ grant_type: p.grant, client_id: p.clientId });
    if (p.scope && p.grant === 'client_credentials') form.set('scope', p.scope);
    const clientSecret = p.clientSecretEnv ? this.env[p.clientSecretEnv] : undefined;
    if (p.clientSecretEnv && !clientSecret) { m.status = 'missing_client_secret'; throw unavailable(); }
    if (clientSecret) form.set('client_secret', clientSecret);
    if (p.grant === 'refresh_token') {
      const refresh = this.decrypt(p) ?? this.env[p.refreshTokenEnv!];
      if (!refresh) { m.status = 'missing_refresh_token'; throw unavailable(); }
      if (!this.saved[p.id]) { try { this.persist(p, refresh); } catch { m.blocked = true; m.status = 'storage_error'; throw unavailable(); } }
      form.set('refresh_token', refresh);
    }
    let response: Response;
    try { response = await this.transport(p.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(), redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { m.status = 'renewal_unavailable'; m.retryAt = this.now() + 30000; throw unavailable(); }
    if (!response.ok) {
      m.status = [400, 401, 403].includes(response.status) ? 'reauthorization_required' : 'renewal_unavailable';
      m.blocked = m.status === 'reauthorization_required'; m.retryAt = this.now() + 30000;
      throw unavailable(); // Never include the upstream body or a token in errors.
    }
    try {
      const raw = await response.text(); if (raw.length > 100000) throw new Error('oversize');
      const value = tokenResponse.parse(JSON.parse(raw));
      // Persist rotation before distributing a new access token. Retain old refresh if omitted.
      if (value.refresh_token && p.grant === 'refresh_token') {
        try { this.persist(p, value.refresh_token); } catch { m.status = 'storage_error'; m.blocked = true; throw unavailable(); }
      }
      const parts = value.access_token.split('.'); if (parts.length !== 3 || /\s/.test(value.access_token)) throw new Error('invalid JWT');
      const claims = z.object({ sub: z.string(), aud: z.union([z.string(), z.array(z.string())]), exp: z.number().int() }).parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
      // These checks bind a TLS-delivered Keycloak token to the configured identity.
      // Ledger/Wallet APIs remain responsible for cryptographic JWT verification.
      if (claims.sub !== p.expectedSubject || !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(p.audience)) throw new Error('identity mismatch');
      const expiresAt = Math.min(claims.exp * 1000, this.now() + value.expires_in * 1000);
      if (expiresAt <= this.now() + 60000) throw new Error('short lifetime');
      Object.assign(m, { token: value.access_token, expiresAt, lastRenewedAt: this.now(), status: 'ready', retryAt: undefined });
      return value.access_token;
    } catch { if (!m.blocked) { m.status = 'invalid_token_response'; m.blocked = true; } throw unavailable(); }
  }
  async tick() { await Promise.allSettled(this.providers.map(p => this.get(p.tokenEnvs[0]))); }
  async drain() { await Promise.allSettled([...this.flights.values()]); }
}
