import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, decimal, format } from './money.js';
import { partyId, offerStatus, type DevnetWallet, type Offer, type WalletCheck, DEVNET_DOMAIN } from './devnet-wallet.js';
import type { Session } from './store.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export const receiptKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const requestInput = z.object({
  key: receiptKey, network: z.literal('devnet'), company: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200), party: partyId, wallet: z.string().trim().min(2).max(100),
  amount: z.string().max(30), purpose: z.string().trim().min(5).max(500),
  consent: z.literal(true), acceptsOffers: z.literal(true), website: z.literal('').default(''),
}).strict();
type Row = { id: string; keyHash: string; input: string; status: string; createdAt: string; updatedAt: string; note: string; offer: string | null; evidence: string | null; error: string | null };
export class PublicFunding {
  private db: DatabaseSync;
  private busy = new Set<string>();
  private checked: WalletCheck | null = null;
  constructor(file: string, private wallet?: DevnetWallet, readonly sendsEnabled = false, private now = Date.now) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS public_funding(id TEXT PRIMARY KEY,keyHash TEXT UNIQUE NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,note TEXT NOT NULL,offer TEXT,evidence TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS funding_events(id INTEGER PRIMARY KEY,requestId TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS funding_rate(key TEXT PRIMARY KEY,until INTEGER NOT NULL,count INTEGER NOT NULL);
    `);
  }
  close() { this.db.close(); }
  private time() { return new Date(this.now()).toISOString(); }
  private operator(s: Session) { if (s.role !== 'operator') throw new AppError('FORBIDDEN', 'Operator access required.', 403); }
  private row(id: string) { const r = this.db.prepare('SELECT * FROM public_funding WHERE id=?').get(id) as Row | undefined; if (!r) throw new AppError('NOT_FOUND', 'Request not found.', 404); return r; }
  private event(id: string, actor: string, kind: string) { this.db.prepare('INSERT INTO funding_events(requestId,at,actor,kind) VALUES (?,?,?,?)').run(id, this.time(), actor, kind); }
  private change(id: string, actor: string, status: string, error: string | null = null, evidence?: unknown) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.row(id);
      this.db.prepare('UPDATE public_funding SET status=?,updatedAt=?,error=?,evidence=COALESCE(?,evidence) WHERE id=?').run(status, this.time(), error, evidence ? JSON.stringify(evidence) : null, id);
      if (previous.status !== status || previous.error !== error) this.event(id, actor, status);
      this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  rate(ip: string, kind: string, limit: number) {
    const key = hash(ip + ':' + kind), now = this.now();
    this.db.prepare('DELETE FROM funding_rate WHERE until<=?').run(now);
    this.db.prepare('INSERT INTO funding_rate VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 60000);
    if (Number(this.db.prepare('SELECT count FROM funding_rate WHERE key=?').get(key)!.count) > limit) throw new AppError('RATE_LIMITED', 'Too many requests. Wait one minute and try again.', 429);
  }
  info() { return { network: 'devnet', maxRequestCc: '10', budgetCc: '100', transfersEnabled: !!this.wallet && this.sendsEnabled, acceptance: 'Accept the transfer offer in your own compatible Splice wallet. Mainnet and preapproval-only wallets are not supported by this demo.' }; }
  private view(r: Row, admin = false) {
    const { email, ...input } = JSON.parse(r.input);
    return { id: r.id, ...input, ...(admin ? { email } : {}), status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt, note: r.note,
      trackingId: r.offer ? (JSON.parse(r.offer) as Offer).tracking_id : null,
      sender: r.offer ? JSON.parse(r.offer).sender : null,
      expiresAt: r.offer ? new Date((JSON.parse(r.offer) as Offer).expires_at / 1000).toISOString() : null,
      evidence: r.evidence ? JSON.parse(r.evidence) : null, error: r.error,
      events: this.db.prepare(`SELECT at,kind${admin ? ',actor' : ''} FROM funding_events WHERE requestId=? ORDER BY id`).all(r.id) };
  }
  request(raw: unknown) {
    const parsed = requestInput.parse(raw), amount = format(decimal(parsed.amount, 10, 10n), 10);
    const { key, website, ...input } = parsed; input.amount = amount; input.email = input.email.toLowerCase();
    const payload = JSON.stringify(input), keyHash = hash(key);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT * FROM public_funding WHERE keyHash=?').get(keyHash) as Row | undefined;
      if (old) { if (old.input !== payload) throw new AppError('REPLAY_MISMATCH', 'This saved request has different details. Restore its original details or open its tracking link.', 409); this.db.exec('COMMIT'); return this.view(old); }
      const rows = this.db.prepare('SELECT * FROM public_funding').all() as Row[];
      if (rows.length >= 2000) throw new AppError('INTAKE_FULL', 'Demo intake is full. Contact the operator.', 503);
      if (rows.some(r => !['rejected', 'failed'].includes(r.status) && JSON.parse(r.input).party === input.party)) throw new AppError('EXISTING_REQUEST', 'This party already has a request. Use your saved tracking link or contact the operator.', 409);
      const id = randomUUID(), at = this.time();
      this.db.prepare('INSERT INTO public_funding VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)').run(id, keyHash, payload, 'pending', at, at, '');
      this.event(id, 'requester', 'pending'); this.db.exec('COMMIT'); return this.view(this.row(id));
    } catch(e) { try { this.db.exec('ROLLBACK'); } catch { /* Read after commit may fail without an open transaction. */ } throw e; }
  }
  track(raw: unknown) {
    const key = receiptKey.parse(z.object({ key: receiptKey }).strict().parse(raw).key);
    const r = this.db.prepare('SELECT * FROM public_funding WHERE keyHash=?').get(hash(key)) as Row | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No request found for this private tracking key.', 404);
    return this.view(r);
  }
  state(s: Session) {
    this.operator(s); const requests = (this.db.prepare('SELECT * FROM public_funding ORDER BY createdAt DESC').all() as Row[]).map(r => this.view(r, true));
    const sum = (statuses: string[]) => format(requests.filter(r => statuses.includes(r.status)).reduce((n, r) => n + decimal(r.amount, 10, 10n), 0n), 10);
    return { ...this.info(), credentialStatus: this.wallet?.credentialStatus?.() ?? { mode: 'manual', status: 'manual_token', expiresAt: null, lastRenewedAt: null }, wallet: this.checked, requests, reservedCc: sum(['approved', 'submitting', 'uncertain', 'created', 'accepted', 'completed']), deliveredCc: sum(['completed']) };
  }
  async check(s: Session) { this.operator(s); this.checked = null; if (!this.wallet) throw new AppError('WALLET_DISABLED', 'Configure the server treasury wallet first.', 503); this.checked = await this.wallet.check(); return this.checked; }
  review(s: Session, id: string, raw: unknown) {
    this.operator(s);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().min(5).max(500), recipientVerified: z.boolean() }).strict().parse(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.row(id);
      if (r.status !== 'pending') throw new AppError('ALREADY_REVIEWED', 'This request has already been reviewed.', 409);
      if (b.decision === 'approved') {
        if (!b.recipientVerified) throw new AppError('VERIFY_RECIPIENT', 'Confirm the recipient controls this Devnet party and can accept Splice wallet offers.');
        const used = (this.db.prepare("SELECT input FROM public_funding WHERE status NOT IN ('pending','rejected','failed')").all() as {input:string}[]).reduce((n, r) => n + decimal(JSON.parse(r.input).amount, 10, 10n), 0n);
        if (used + decimal(JSON.parse(r.input).amount, 10, 10n) > 100n * 10n ** 10n) throw new AppError('BUDGET_LIMIT', 'The 100 CC demo delivery budget is fully reserved.', 409);
      }
      this.db.prepare('UPDATE public_funding SET status=?,note=?,updatedAt=? WHERE id=?').run(b.decision, b.note, this.time(), id);
      this.event(id, s.id, b.decision); this.db.exec('COMMIT'); return this.view(this.row(id), true);
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async send(s: Session, id: string) {
    this.operator(s);
    if (!this.wallet || !this.sendsEnabled) throw new AppError('TRANSFERS_DISABLED', 'Devnet sends are disabled on this server.', 503);
    if (this.busy.has(id)) throw new AppError('BUSY', 'This request is already being processed.', 409);
    this.busy.add(id);
    try {
      const r = this.row(id);
      if (r.status !== 'approved') return this.view(r, true); // Never repeat a monetary POST.
      const input = JSON.parse(r.input), check = await this.check(s);
      if (check.synchronizer !== DEVNET_DOMAIN || check.party === input.party) throw new AppError('INVALID_RECIPIENT', 'Use a different recipient party on Devnet.', 409);
      // Require at least one CC of headroom; actual wallet fees remain authoritative.
      const balance = BigInt(check.balanceCc.split('.')[0]) * 10n ** 10n + BigInt((check.balanceCc.split('.')[1] ?? '').padEnd(10, '0'));
      if (balance < decimal(input.amount, 10, 10n) + 10n ** 10n) throw new AppError('INSUFFICIENT_FUNDS', 'Insufficient unlocked CC including one CC of fee headroom.', 409);
      const offer: Offer = { receiver_party_id: input.party, amount: input.amount, description: `ClearRoute Devnet ${id}`, tracking_id: `clearroute-devnet-${id}`, expires_at: (this.now() + 24 * 3600000) * 1000 };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const changed = this.db.prepare("UPDATE public_funding SET status='submitting',offer=?,updatedAt=? WHERE id=? AND status='approved'").run(JSON.stringify({ ...offer, sender: check.party }), this.time(), id);
        if (!changed.changes) { this.db.exec('COMMIT'); return this.view(this.row(id), true); }
        this.event(id, s.id, 'submitting'); this.db.exec('COMMIT');
      } catch(e) { this.db.exec('ROLLBACK'); throw e; }
      try { await this.wallet.create(offer); } catch { this.change(id, s.id, 'uncertain', 'Submission could not be confirmed. Reconcile this tracking ID; do not send again.'); return this.view(this.row(id), true); }
      return await this.readStatus(s, id);
    } finally { this.busy.delete(id); }
  }
  private async readStatus(s: Session, id: string) {
    const r = this.row(id), offer: Offer = JSON.parse(r.offer!);
    try {
      const evidence = offerStatus.parse(await this.wallet!.status(offer.tracking_id));
      this.change(id, s.id, evidence.status, null, { ...evidence, trackingId: offer.tracking_id, amountCc: offer.amount, receiver: offer.receiver_party_id, source: 'NODERS wallet transfer status', checkedAt: this.time() });
    } catch { this.change(id, s.id, ['created', 'accepted'].includes(r.status) ? r.status : 'uncertain', 'Wallet status unavailable. Nothing was resent. Refresh credentials if needed, then reconcile.'); }
    return this.view(this.row(id), true);
  }
  async reconcile(s: Session, id: string) {
    this.operator(s); const r = this.row(id);
    if (!r.offer || ['completed', 'failed'].includes(r.status)) return this.view(r, true);
    if (!this.wallet) throw new AppError('WALLET_DISABLED', 'Configure wallet access to reconcile.', 503);
    if (this.busy.has(id)) throw new AppError('BUSY', 'This request is already being processed.', 409);
    this.busy.add(id);
    try {
      const check = await this.check(s);
      if (check.party !== JSON.parse(r.offer).sender) throw new AppError('TREASURY_MISMATCH', 'Restore the original treasury identity before reconciling this request.', 409);
      return await this.readStatus(s, id);
    } finally { this.busy.delete(id); }
  }
  async tick() {
    if (!this.wallet) return;
    const actor: Session = { id: 'wallet-reconciler', role: 'operator', tenantId: null };
    const rows = this.db.prepare("SELECT id FROM public_funding WHERE status IN ('submitting','uncertain','created','accepted') ORDER BY updatedAt LIMIT 5").all() as {id:string}[];
    for (const r of rows) { if (!this.busy.has(r.id)) { try { await this.reconcile(actor, r.id); } catch { /* Credential failures must never submit a payment. Operator can refresh access. */ } } }
  }
}
