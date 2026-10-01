import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './money.js';

export type Tenant = 'atlas' | 'nova';
export type Binding = { party: string; user: string; validator: string; domain: string };
export type Measurement = { complete: boolean; bytes: number; chargeUsd: string; updateIds: string[] };
export type SponsorDependencies = {
  binding(tenant: Tenant): Promise<Binding>;
  purchase(bytes: number, key: string): Promise<any>;
  reconcilePurchase(id: string): Promise<void>;
  getPurchase(id: string): any;
  run(tenant: Tenant, key: string): Promise<any>;
  measure(run: any): Promise<Measurement>;
};
export const policyInput = z.object({ enabled: z.boolean(), batchBytes: z.number().int().min(200000).max(1000000), capacityLimitBytes: z.number().int().min(200000).max(10000000) }).strict();
type Row = Record<string, any>;

// This journal coordinates external effects; it never assumes SQLite can roll
// back an already submitted wallet or ledger operation. All external keys are
// derived from the durable request ID and replayed unchanged after a crash.
export class Sponsorship {
  private db: DatabaseSync;
  private working = false;
  constructor(directory: string, private deps: SponsorDependencies) {
    this.db = new DatabaseSync(path.join(directory, 'sponsorship.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sponsor_policies(tenant TEXT PRIMARY KEY, enabled INTEGER NOT NULL, batchBytes INTEGER NOT NULL, capacityLimitBytes INTEGER NOT NULL, binding TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sponsor_requests(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, requestKey TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL, binding TEXT NOT NULL, policyRevision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, purchase TEXT, run TEXT, measurement TEXT, error TEXT, UNIQUE(tenant,requestKey));
      CREATE TABLE IF NOT EXISTS sponsor_audit(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,at TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  private event(tenant: string, kind: string, body: unknown) { this.db.prepare('INSERT INTO sponsor_audit VALUES (?,?,?,?,?)').run(randomUUID(), tenant, new Date().toISOString(), kind, JSON.stringify(body)); }
  private policy(tenant: string) { return this.db.prepare('SELECT * FROM sponsor_policies WHERE tenant=?').get(tenant) as Row | undefined; }
  private used(tenant: string) { return Number((this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM sponsor_requests WHERE tenant=? AND status!='funding_failed'").get(tenant) as Row).n); }
  private row(id: string) { const row = this.db.prepare('SELECT * FROM sponsor_requests WHERE id=?').get(id) as Row | undefined; if (!row) throw new AppError('NOT_FOUND', 'Sponsorship request not found.', 404); return row; }
  private view(row: Row) { return { id: String(row.id), tenant: String(row.tenant), status: String(row.status), bytes: Number(row.bytes), policyRevision: Number(row.policyRevision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), error: row.error ? String(row.error) : null, binding: JSON.parse(row.binding) as Binding, purchase: row.purchase ? JSON.parse(row.purchase) : null, run: row.run ? JSON.parse(row.run) : null, measurement: row.measurement ? JSON.parse(row.measurement) as Measurement : null }; }
  get(id: string, tenant?: string) { const row = this.row(id); if (tenant && row.tenant !== tenant) throw new AppError('NOT_FOUND', 'Sponsorship request not found.', 404); return this.view(row); }
  state(tenant?: string) {
    const params = tenant ? [tenant] : [];
    const policies = (this.db.prepare('SELECT * FROM sponsor_policies' + (tenant ? ' WHERE tenant=?' : '')).all(...params) as Row[]).map(p => ({ ...p, enabled: !!p.enabled, binding: JSON.parse(p.binding), reservedCapacityBytes: this.used(p.tenant), remainingCapacityBytes: Math.max(0, p.capacityLimitBytes - this.used(p.tenant)) }));
    const requests = (this.db.prepare('SELECT * FROM sponsor_requests' + (tenant ? ' WHERE tenant=?' : '') + ' ORDER BY rowid DESC LIMIT 100').all(...params) as Row[]).map(r => this.view(r));
    const audit = (this.db.prepare('SELECT * FROM sponsor_audit' + (tenant ? ' WHERE tenant=?' : '') + ' ORDER BY rowid DESC LIMIT 100').all(...params) as Row[]).map(r => ({ id: String(r.id), tenant: String(r.tenant), at: String(r.at), kind: String(r.kind), body: JSON.parse(r.body) }));
    return { network: 'LocalNet', workflow: 'launchfuel-service-v1', policies, requests, audit };
  }
  async approve(tenant: Tenant, input: z.infer<typeof policyInput>) {
    const body = policyInput.parse(input);
    if (body.capacityLimitBytes < body.batchBytes) throw new AppError('INVALID_LIMIT', 'Capacity allowance must cover at least one batch.');
    // Pausing must remain possible during a network outage.
    const old = this.policy(tenant);
    const binding = !body.enabled && old ? JSON.parse(old.binding) : await this.deps.binding(tenant);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (body.capacityLimitBytes < this.used(tenant)) throw new AppError('LIMIT_RESERVED', 'The allowance cannot be reduced below purchased or reserved capacity.');
      const current = this.policy(tenant);
      if (current && current.binding !== JSON.stringify(binding) && this.used(tenant) > 0) throw new AppError('IDENTITY_CHANGED', 'Existing sponsorship records belong to a different network identity.', 409);
      this.db.prepare('INSERT INTO sponsor_policies VALUES (?,?,?,?,?,1) ON CONFLICT(tenant) DO UPDATE SET enabled=excluded.enabled,batchBytes=excluded.batchBytes,capacityLimitBytes=excluded.capacityLimitBytes,binding=excluded.binding,revision=revision+1').run(tenant, body.enabled ? 1 : 0, body.batchBytes, body.capacityLimitBytes, JSON.stringify(binding));
      this.event(tenant, body.enabled ? 'policy.approved' : 'policy.paused', { ...body, binding });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return this.state(tenant);
  }
  async submit(tenant: Tenant, key: string) {
    if (!/^[\w-]{8,100}$/.test(key)) throw new AppError('IDEMPOTENCY_REQUIRED', 'A stable sponsorship request key is required.');
    let id: string;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT id FROM sponsor_requests WHERE tenant=? AND requestKey=?').get(tenant, key) as Row | undefined;
      if (prior) id = prior.id;
      else {
        const p = this.policy(tenant);
        if (!p?.enabled) throw new AppError('SPONSORSHIP_DISABLED', 'The operator must approve sponsorship for this application.', 403);
        if (this.used(tenant) + p.batchBytes > p.capacityLimitBytes) throw new AppError('CAPACITY_LIMIT', 'The approved sponsorship capacity allowance is exhausted.', 409);
        if (this.db.prepare("SELECT id FROM sponsor_requests WHERE tenant=? AND status NOT IN ('completed','funding_failed')").get(tenant)) throw new AppError('SPONSORSHIP_PENDING', 'Resolve this application’s existing sponsorship request first.', 409);
        id = `sponsor-${randomUUID()}`;
        const now = new Date().toISOString();
        this.db.prepare('INSERT INTO sponsor_requests(id,tenant,requestKey,status,bytes,binding,policyRevision,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run(id, tenant, key, 'awaiting_funding', p.batchBytes, p.binding, p.revision, now, now);
        this.event(tenant, 'request.authorized', { id, capacityBytes: p.batchBytes, policyRevision: p.revision });
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    await this.reconcile(id);
    return this.get(id);
  }
  private update(id: string, status: string, fields: { purchase?: unknown; run?: unknown; measurement?: unknown; error?: string | null } = {}) {
    const row = this.row(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE sponsor_requests SET status=?,purchase=?,run=?,measurement=?,error=?,updatedAt=? WHERE id=?').run(status, fields.purchase === undefined ? row.purchase : JSON.stringify(fields.purchase), fields.run === undefined ? row.run : JSON.stringify(fields.run), fields.measurement === undefined ? row.measurement : JSON.stringify(fields.measurement), fields.error ?? null, new Date().toISOString(), id);
      if (status !== row.status) this.event(row.tenant, `request.${status}`, { id });
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async reconcile(id: string) {
    const initial = this.row(id);
    if (this.working || ['completed', 'funding_failed'].includes(initial.status)) return;
    this.working = true;
    try {
      let row = this.row(id);
      const binding = await this.deps.binding(row.tenant);
      if (JSON.stringify(binding) !== row.binding) throw new Error('Application or validator identity changed; sponsorship is blocked.');
      if (!this.policy(row.tenant)?.enabled) throw new Error('Sponsorship is paused. Existing reservations and evidence are retained.');
      if (row.status === 'awaiting_funding') {
        let purchase = await this.deps.purchase(row.bytes, `${id}-fund`);
        await this.deps.reconcilePurchase(purchase.id);
        purchase = this.deps.getPurchase(purchase.id);
        if (purchase.target.party !== binding.validator || purchase.target.domain !== binding.domain || purchase.bytes !== row.bytes) throw new Error('Funding receipt destination does not match the approved validator.');
        if (['failed', 'rejected'].includes(purchase.status)) { this.update(id, 'funding_failed', { purchase, error: purchase.error || 'Traffic purchase failed.' }); return; }
        if (purchase.status !== 'completed' || !purchase.evidence?.purchase) { this.update(id, 'awaiting_funding', { purchase, error: purchase.error || 'Waiting for a verified traffic purchase receipt.' }); return; }
        this.update(id, 'awaiting_ledger', { purchase });
        row = this.row(id);
      }
      if (['awaiting_ledger', 'needs_reconciliation'].includes(row.status)) {
        if (JSON.stringify(await this.deps.binding(row.tenant)) !== row.binding) throw new Error('Identity changed before execution; request blocked.');
        // A fresh approval check closes the pause-during-purchase race.
        if (!this.policy(row.tenant)?.enabled) throw new Error('Sponsorship paused before ledger execution.');
        const run = await this.deps.run(row.tenant, `${id}-ledger`);
        if (!run || run.status !== 'completed') { this.update(id, 'needs_reconciliation', { run, error: run?.error || 'Ledger outcome requires reconciliation. No new command will be created.' }); return; }
        this.update(id, 'awaiting_measurement', { run });
        row = this.row(id);
      }
      if (row.status === 'awaiting_measurement') {
        const measurement = await this.deps.measure(JSON.parse(row.run));
        if (!measurement.complete) { this.update(id, 'awaiting_measurement', { error: 'Waiting for all customer completions and matching transaction evidence.' }); return; }
        this.update(id, 'completed', { measurement });
      }
    } catch (e) { this.update(id, this.row(id).status, { error: e instanceof Error ? e.message : 'Sponsorship result unavailable.' }); }
    finally { this.working = false; }
  }
  async tick() {
    const rows = this.db.prepare("SELECT id FROM sponsor_requests WHERE status NOT IN ('completed','funding_failed') ORDER BY rowid LIMIT 20").all() as Row[];
    for (const row of rows) await this.reconcile(row.id);
  }
}
