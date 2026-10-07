import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { AppError, decimal, format, price, FIXTURE_RATE, FIXTURE_CC_PER_BYTE } from './money.js';

type Row = Record<string, any>;
export type Session = { id: string; role: 'operator' | 'customer'; tenantId: string | null };
const DAY = 86_400_000;
export const PERIOD = 15 * DAY;
const id = (prefix: string) => `${prefix}-${randomUUID()}`;

export class Store {
  db: DatabaseSync;
  constructor(path: string, clock = Date.now()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY,name TEXT NOT NULL,partyId TEXT NOT NULL,status TEXT NOT NULL,limitMicro TEXT NOT NULL,periodStart INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY,tenantId TEXT NOT NULL REFERENCES tenants(id),mode TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,limitMicro TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS charges (id TEXT PRIMARY KEY,tenantId TEXT NOT NULL REFERENCES tenants(id),kind TEXT NOT NULL,createdAt INTEGER NOT NULL,description TEXT NOT NULL,trafficBytes INTEGER NOT NULL,ccUnits TEXT NOT NULL,rateMicro TEXT NOT NULL,amountMicro TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,invoiceId TEXT);
      CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY,tenantId TEXT NOT NULL REFERENCES tenants(id),periodStart INTEGER NOT NULL,periodEnd INTEGER NOT NULL,createdAt INTEGER NOT NULL,dueAt INTEGER NOT NULL,totalMicro TEXT NOT NULL,UNIQUE(tenantId,periodStart));
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY,invoiceId TEXT NOT NULL REFERENCES invoices(id),amountMicro TEXT NOT NULL,rail TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,at INTEGER NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,tenantId TEXT);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL);
    `);
    if (!this.getMeta('clock')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.setMeta('clock', String(clock));
        this.setMeta('reserveCc', String(1000n * 100_000_000n));
        this.setMeta('spentCc', '0'); this.setMeta('trafficBytes', '0');
        for (const [tenantId, name] of [['atlas', 'Atlas Labs'], ['nova', 'Nova Markets']]) {
          this.db.prepare('INSERT INTO tenants VALUES (?,?,?,?,?,?)').run(tenantId, name, `${tenantId}::demo-party`, 'needs_setup', '25000000', clock);
        }
        this.event('demo.started', 'Local demo created. Network actions, prices, and payments are simulated.');
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
  }
  close() { this.db.close(); }
  rows(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  row(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  getMeta(key: string): string | undefined { return this.row('SELECT value FROM meta WHERE key=?', key)?.value; }
  setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  now() { return Number(this.getMeta('clock')); }
  event(type: string, message: string, tenantId?: string) { this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(id('evt'), this.now(), type, message, tenantId ?? null); }
  session(value: unknown): Session {
    if (value === 'operator') return { id: 'operator', role: 'operator', tenantId: null };
    if (value === 'atlas' || value === 'nova') return { id: value, role: 'customer', tenantId: value };
    throw new AppError('UNAUTHORIZED', 'Choose an explicitly labeled local demo session.', 401);
  }
  authorize(session: Session, tenantId: string) {
    if (session.role !== 'operator' && session.tenantId !== tenantId) throw new AppError('FORBIDDEN', 'This account cannot access that customer.', 403);
    const tenant = this.row('SELECT * FROM tenants WHERE id=?', tenantId);
    if (!tenant) throw new AppError('NOT_FOUND', 'Customer account not found.', 404);
    return tenant;
  }
  operator(session: Session) { if (session.role !== 'operator') throw new AppError('FORBIDDEN', 'An operator account is required for this action.', 403); }
  invoicePaid(invoiceId: string) { return this.rows('SELECT amountMicro FROM payments WHERE invoiceId=?', invoiceId).reduce((s, r) => s + BigInt(r.amountMicro), 0n); }
  exposure(tenantId: string) {
    const unbilled = this.rows('SELECT amountMicro FROM charges WHERE tenantId=? AND invoiceId IS NULL', tenantId).reduce((s, r) => s + BigInt(r.amountMicro), 0n);
    const outstanding = this.rows('SELECT id,totalMicro FROM invoices WHERE tenantId=?', tenantId).reduce((s, r) => s + BigInt(r.totalMicro) - this.invoicePaid(r.id), 0n);
    return { unbilled, outstanding, total: unbilled + outstanding };
  }
  checkLimit(tenant: Row, amount: bigint) {
    if (this.exposure(tenant.id).total + amount > BigInt(tenant.limitMicro)) throw new AppError('ACCOUNT_LIMIT', 'This action exceeds the demo account limit, including unbilled usage and unpaid invoices.');
  }
  quote() {
    const start = Math.floor(this.now() / 300000) * 300000;
    return { id: `fixture-v1-${start}`, usdPerCc: format(FIXTURE_RATE, 6), observedAt: new Date(start).toISOString(), expiresAt: new Date(start + 300000).toISOString(), source: 'Fixture — not live' };
  }
  mutation(session: Session, key: string, action: string, body: unknown, fn: () => any) {
    if (!key || key.length > 150 || !/^[\w-]+$/.test(key)) throw new AppError('IDEMPOTENCY_REQUIRED', 'A stable idempotency key is required.');
    const scope = `${session.id}:${key}`;
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, body })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.row('SELECT * FROM idempotency WHERE key=?', scope);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError('IDEMPOTENCY_CONFLICT', 'This request key already belongs to a different action.', 409);
        this.db.exec('COMMIT'); return JSON.parse(existing.response);
      }
      const result = fn();
      this.db.prepare('INSERT INTO idempotency VALUES (?,?,?)').run(scope, fingerprint, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  request(session: Session, input: { tenantId: string; mode: string; limitUsd: string }) {
    this.authorize(session, input.tenantId);
    if (input.mode !== 'managed') throw new AppError('INVALID_MODE', 'Use the top-up order flow for direct CC delivery.');
    const limit = decimal(input.limitUsd, 6, 1000n);
    if (this.row("SELECT id FROM requests WHERE tenantId=? AND status='pending'", input.tenantId)) throw new AppError('REQUEST_PENDING', 'A managed-service request is already awaiting review.');
    const requestId = id('req');
    this.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?)').run(requestId, input.tenantId, 'managed', 'pending', this.now(), limit.toString());
    this.event('account.requested', 'Managed usage requested. Awaiting operator approval.', input.tenantId);
    return { id: requestId, status: 'pending' };
  }
  approve(session: Session, requestId: string, limitUsd: string) {
    this.operator(session);
    const request = this.row('SELECT * FROM requests WHERE id=?', requestId);
    if (!request) throw new AppError('NOT_FOUND', 'Request not found.', 404);
    if (request.status !== 'pending') throw new AppError('ALREADY_REVIEWED', 'This request has already been reviewed.', 409);
    const limit = decimal(limitUsd, 6, 1000n);
    if (limit < this.exposure(request.tenantId).total) throw new AppError('LIMIT_BELOW_EXPOSURE', 'The limit cannot be lower than existing outstanding charges.');
    this.db.prepare("UPDATE requests SET status='approved',limitMicro=? WHERE id=?").run(limit.toString(), requestId);
    this.db.prepare("UPDATE tenants SET status='active',limitMicro=? WHERE id=?").run(limit.toString(), request.tenantId);
    this.event('account.approved', `Managed usage approved with a $${format(limit, 6)} demo limit.`, request.tenantId);
    return { id: requestId, status: 'approved' };
  }
  fund(trafficBytes: number) {
    const cc = BigInt(trafficBytes) * FIXTURE_CC_PER_BYTE;
    const reserve = BigInt(this.getMeta('reserveCc')!);
    if (reserve < cc) throw new AppError('TREASURY_LOW', 'The simulated provider reserve is insufficient.');
    this.setMeta('reserveCc', String(reserve - cc));
    this.setMeta('spentCc', String(BigInt(this.getMeta('spentCc')!) + cc));
    this.setMeta('trafficBytes', String(Number(this.getMeta('trafficBytes')) + trafficBytes));
    this.event('traffic.purchased', `Demo purchase: ${trafficBytes.toLocaleString('en-US')} traffic bytes for ${format(cc, 8)} simulated CC.`);
    return { trafficBytes, ccAmount: format(cc, 8), reference: id('demo-traffic') };
  }
  usage(session: Session, input: {tenantId: string; trafficBytes: number; description: string}) {
    const tenant = this.authorize(session, input.tenantId);
    if (tenant.status !== 'active') throw new AppError('ACCOUNT_NOT_READY', 'Request managed usage and obtain operator approval first.');
    const cc = BigInt(input.trafficBytes) * FIXTURE_CC_PER_BYTE;
    const amount = price(cc);
    this.checkLimit(tenant, amount);
    const available = Number(this.getMeta('trafficBytes'));
    if (available < input.trafficBytes) this.fund(Math.max(200000, input.trafficBytes - available));
    this.setMeta('trafficBytes', String(Number(this.getMeta('trafficBytes')) - input.trafficBytes));
    const usageId = id('use'); const reference = id('demo-completion');
    this.db.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(usageId, tenant.id, 'usage', this.now(), input.description, input.trafficBytes, cc.toString(), FIXTURE_RATE.toString(), amount.toString(), reference);
    this.event('usage.completed', `${input.description}: $${format(amount, 6)} recorded under the fixture tariff.`, tenant.id);
    return { id: usageId, status: 'completed', reference, chargeUsd: format(amount, 6) };
  }
  topup(session: Session, input: {tenantId: string; ccAmount: string; quoteId: string}) {
    const tenant = this.authorize(session, input.tenantId);
    if (input.quoteId !== this.quote().id) throw new AppError('QUOTE_EXPIRED', 'The quote expired. Refresh it and review the new quote before retrying.');
    const cc = decimal(input.ccAmount, 8, 100n); const amount = price(cc);
    if (amount < 1n) throw new AppError('BELOW_MINIMUM', 'The amount is below the demo billing precision.');
    this.checkLimit(tenant, amount);
    const reserve = BigInt(this.getMeta('reserveCc')!);
    if (reserve < cc) throw new AppError('TREASURY_LOW', 'The simulated provider reserve is insufficient.');
    this.setMeta('reserveCc', String(reserve - cc));
    const topupId = id('top'); const reference = id('demo-transfer');
    this.db.prepare('INSERT INTO charges VALUES (?,?,?,?,?,?,?,?,?,?,NULL)').run(topupId, tenant.id, 'topup', this.now(), `Direct top-up: ${format(cc, 8)} CC (simulated)`, 0, cc.toString(), FIXTURE_RATE.toString(), amount.toString(), reference);
    this.event('topup.completed', `${format(cc, 8)} simulated CC delivered. This does not purchase validator traffic.`, tenant.id);
    return { id: topupId, status: 'completed', reference, chargeUsd: format(amount, 6) };
  }
  closePeriod(session: Session, tenantId: string) {
    this.operator(session); const tenant = this.authorize(session, tenantId);
    const start = Number(tenant.periodStart); const end = start + PERIOD;
    if (this.now() < end) throw new AppError('PERIOD_OPEN', 'This 15-day period is still open. Use the demo clock to advance 15 days.');
    const charges = this.rows('SELECT * FROM charges WHERE tenantId=? AND invoiceId IS NULL AND createdAt>=? AND createdAt<? ORDER BY createdAt,id', tenantId, start, end);
    const total = charges.reduce((s, row) => s + BigInt(row.amountMicro), 0n);
    const invoiceId = `LF-${String(Number(this.row('SELECT COUNT(*) AS n FROM invoices')!.n) + 1).padStart(5, '0')}`;
    this.db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?,?)').run(invoiceId, tenantId, start, end, this.now(), this.now(), total.toString());
    for (const row of charges) this.db.prepare('UPDATE charges SET invoiceId=? WHERE id=?').run(invoiceId, row.id);
    this.db.prepare('UPDATE tenants SET periodStart=? WHERE id=?').run(end, tenantId);
    this.event('invoice.issued', `${invoiceId}: $${format(total, 6)} for a completed 15-day demo period.`, tenantId);
    return { id: invoiceId, totalUsd: format(total, 6) };
  }
  payment(session: Session, invoiceId: string, input: {amountUsd: string; rail: string; reference: string}) {
    this.operator(session); const invoice = this.row('SELECT * FROM invoices WHERE id=?', invoiceId);
    if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found.', 404);
    const amount = decimal(input.amountUsd, 6);
    const remaining = BigInt(invoice.totalMicro) - this.invoicePaid(invoiceId);
    if (amount > remaining) throw new AppError('OVERPAYMENT', 'The amount exceeds this invoice’s outstanding balance.');
    if (this.row('SELECT id FROM payments WHERE reference=?', input.reference)) throw new AppError('DUPLICATE_PAYMENT', 'This simulated payment reference was already reconciled.', 409);
    this.db.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?)').run(id('pay'), invoiceId, amount.toString(), input.rail, input.reference, this.now());
    this.event('payment.simulated', `Simulated ${input.rail} payment of $${format(amount, 6)} allocated to ${invoiceId}. No real money received.`, invoice.tenantId);
    return { id: invoiceId, paidUsd: format(this.invoicePaid(invoiceId), 6) };
  }
  state(session: Session) {
    const all = session.role === 'operator'; const where = all ? '' : ' WHERE tenantId=?'; const args = all ? [] : [session.tenantId];
    const charges = this.rows(`SELECT * FROM charges${where} ORDER BY createdAt DESC,id`, ...args);
    const tenants = this.rows(all ? 'SELECT * FROM tenants' : 'SELECT * FROM tenants WHERE id=?', ...args).map(t => {
      const exposure = this.exposure(t.id);
      const used = this.rows("SELECT trafficBytes FROM charges WHERE tenantId=? AND kind='usage'", t.id).reduce((sum,r) => sum + r.trafficBytes,0);
      const available = BigInt(t.limitMicro) > exposure.total ? BigInt(t.limitMicro) - exposure.total : 0n;
      return { id:t.id,name:t.name,partyId:t.partyId,status:t.status,limitUsd:format(t.limitMicro,6),unbilledUsd:format(exposure.unbilled,6),outstandingUsd:format(exposure.outstanding,6),allowanceBytes:Number(available * 100_000_000n / (FIXTURE_CC_PER_BYTE * FIXTURE_RATE)),usedBytes:used };
    });
    const invoices = this.rows(`SELECT * FROM invoices${where} ORDER BY createdAt DESC,id DESC`, ...args).map(i => {
      const paid = this.invoicePaid(i.id); const total = BigInt(i.totalMicro);
      return { id:i.id,tenantId:i.tenantId,periodStart:new Date(i.periodStart).toISOString(),periodEnd:new Date(i.periodEnd).toISOString(),createdAt:new Date(i.createdAt).toISOString(),dueAt:new Date(i.dueAt).toISOString(),totalUsd:format(total,6),paidUsd:format(paid,6),status:paid === total ? 'paid' : this.now()>i.dueAt ? 'overdue' : paid>0n ? 'partially_paid' : 'issued',lines:this.rows('SELECT * FROM charges WHERE invoiceId=? ORDER BY createdAt,id',i.id).map(c=>({description:c.description,amountUsd:format(c.amountMicro,6),reference:c.reference})) };
    });
    return { mode:'demo',environment:'Local demo',now:new Date(this.now()).toISOString(),session:{role:session.role,tenantId:session.tenantId},tenants,
      treasury:all ? {ccBalance:format(this.getMeta('reserveCc')!,8),trafficBytes:Number(this.getMeta('trafficBytes')),spentCc:format(this.getMeta('spentCc')!,8)} : null,
      quote:this.quote(),
      usage:charges.filter(c=>c.kind==='usage').map(c=>({id:c.id,tenantId:c.tenantId,createdAt:new Date(c.createdAt).toISOString(),description:c.description,trafficBytes:c.trafficBytes,ccEquivalent:format(c.ccUnits,8),rateUsd:format(c.rateMicro,6),chargeUsd:format(c.amountMicro,6),status:'completed',reference:c.reference})),
      topups:charges.filter(c=>c.kind==='topup').map(c=>({id:c.id,tenantId:c.tenantId,createdAt:new Date(c.createdAt).toISOString(),ccAmount:format(c.ccUnits,8),chargeUsd:format(c.amountMicro,6),status:'completed',reference:c.reference})),invoices,
      requests:this.rows(`SELECT * FROM requests${where} ORDER BY createdAt DESC`,...args).map(r=>({id:r.id,tenantId:r.tenantId,mode:r.mode,status:r.status,createdAt:new Date(r.createdAt).toISOString(),limitUsd:format(r.limitMicro,6)})),
      events:this.rows(all ? 'SELECT * FROM events ORDER BY at DESC,rowid DESC LIMIT 200' : 'SELECT * FROM events WHERE tenantId=? ORDER BY at DESC,rowid DESC LIMIT 200',...args).map(e=>({...e,at:new Date(e.at).toISOString()})),
      policy:{label:'Fixture tariff v1 — not a live commercial offer',topupTerms:'Demo top-ups use test credit; real payment terms pending.',billing:'Consecutive 15-day UTC periods; due on issue in this demo only.',rate:'0.00002 CC equivalent per simulated traffic byte, valued at $0.20/CC. Zero service fee in fixture only.'},
      readiness:[{name:'Application & billing',status:'ready',detail:'Local SQLite records with idempotency and account isolation.'},{name:'Canton network',status:'partial',detail:'Open LocalNet for checked ledger connectivity and actual sample completions. Funding and metering remain simulated.'},{name:'Hosting partner',status:'pending',detail:'Operator and scoped API access required.'},{name:'Live pricing',status:'pending',detail:'Quote source and pricing policy require selection.'},{name:'USD / USDC settlement',status:'pending',detail:'Rail, token/network, and payment terms not configured.'},{name:'MainNet',status:'disabled',detail:'No real spending or payment collection enabled.'}]
    };
  }
}
