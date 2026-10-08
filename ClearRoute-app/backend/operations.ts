import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './money.js';
import type { Session } from './store.js';
import { type Network, type Profile, type Profiles, networks } from './networks.js';
import { actionSchema, amount, choices, modules, networkValue, templateId, type Template } from './contracts.js';
import { type LedgerCall, hostedLedger, transactionFormat } from './hosted-ledger.js';

const SCALE = 10n ** 10n, DAY = 86400000;
export const fixed = (value: string) => { amount.parse(value); const [w, f = ''] = value.split('.'); return BigInt(w) * SCALE + BigInt(f.padEnd(10, '0')); };
export const display = (v: bigint): string => `${v < 0n ? '-' : ''}${(v < 0n ? -v : v) / SCALE}.${((v < 0n ? -v : v) % SCALE).toString().padStart(10, '0').replace(/0+$/, '').padEnd(2, '0')}`;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code: string, message: string, status = 409): never => { throw new AppError(code, message, status); };
const operator = (s: Session) => { if (s.role !== 'operator') fail('FORBIDDEN', 'Operator access required.', 403); };
type Row = Record<string, any>;
const iso = (n: number) => new Date(n).toISOString();
const plannerSchema = z.object({ growthPercent: z.number().int().min(0).max(300), reserveDays: z.number().int().min(0).max(180), leadDays: z.number().int().min(0).max(90), minimumCc: amount }).strict();
export const policySchema = z.object({ status: z.enum(['approved', 'suspended', 'pending']), limitUsd: amount, maxAllowanceUnits: z.string().regex(/^[1-9]\d{0,14}$/), note: z.string().trim().min(3).max(300) }).strict();
export class Operations {
  private db: DatabaseSync;
  private inflight = new Set<Promise<unknown>>();
  constructor(file: string, private profiles: Profiles, private call: LedgerCall = hostedLedger(), private now = Date.now) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS network_bindings(network TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(network TEXT,tenant TEXT,name TEXT,party TEXT,status TEXT NOT NULL DEFAULT 'pending',limitUsd TEXT NOT NULL DEFAULT '0',maxUnits TEXT NOT NULL DEFAULT '1',PRIMARY KEY(network,tenant),UNIQUE(network,party));
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,network TEXT,tenant TEXT,actor TEXT,userId TEXT,key TEXT,fingerprint TEXT,action TEXT,body TEXT,status TEXT,result TEXT,error TEXT,createdAt TEXT,UNIQUE(network,actor,key));
      CREATE UNIQUE INDEX IF NOT EXISTS pending_tenant ON commands(network,tenant) WHERE status IN ('submitting','uncertain');
      CREATE TABLE IF NOT EXISTS updates(network TEXT,id TEXT,offset TEXT,at TEXT,body TEXT,PRIMARY KEY(network,id));
      CREATE TABLE IF NOT EXISTS contracts(network TEXT,id TEXT,tenant TEXT,template TEXT,payload TEXT,active INTEGER,createdAt TEXT,updateId TEXT,PRIMARY KEY(network,id));
      CREATE TABLE IF NOT EXISTS metrics(network TEXT,kind TEXT,ref TEXT,tenant TEXT,at TEXT,amount TEXT,updateId TEXT,PRIMARY KEY(network,kind,ref));
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,network TEXT,at TEXT,actor TEXT,tenant TEXT,kind TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS settings(network TEXT,key TEXT,value TEXT,PRIMARY KEY(network,key));
      CREATE TABLE IF NOT EXISTS business_refs(network TEXT,kind TEXT,ref TEXT,commandId TEXT,PRIMARY KEY(network,kind,ref));
      CREATE TABLE IF NOT EXISTS funding_recipients(requestId TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS funding_requests(id TEXT PRIMARY KEY,network TEXT,tenant TEXT,requestKey TEXT,mode TEXT,amount TEXT,reason TEXT,status TEXT,createdAt TEXT,decision TEXT,UNIQUE(network,tenant,requestKey));
      UPDATE commands SET status='uncertain',error='Service restarted before confirmation; reconcile this command.' WHERE status='submitting';`);
    try {
      for (const network of networks) {
        const p = profiles[network]; if (!p) continue;
        const fp = hash({ url: p.ledgerUrl, participant: p.participantId, synchronizer: p.synchronizerId, package: p.packageId, provider: p.provider.partyId });
        const previous = this.db.prepare('SELECT fingerprint FROM network_bindings WHERE network=?').get(network) as Row | undefined;
        if (previous && previous.fingerprint !== fp) throw new Error(`Network identity changed for ${network}; use a reviewed migration and separate data directory.`);
        this.db.prepare('INSERT OR IGNORE INTO network_bindings VALUES (?,?)').run(network, fp);
        for (const [tenant, c] of Object.entries(p.customers)) {
          const existing = this.db.prepare('SELECT party FROM accounts WHERE network=? AND tenant=?').get(network, tenant) as Row | undefined;
          if (existing && existing.party !== c.partyId) throw new Error(`Party binding changed for ${network}/${tenant}.`);
          this.db.prepare('INSERT INTO accounts(network,tenant,name,party) VALUES (?,?,?,?) ON CONFLICT(network,tenant) DO UPDATE SET name=excluded.name').run(network, tenant, c.name, c.partyId);
        }
      }
    } catch (error) { this.db.close(); throw error; }
  }
  async drain() { await Promise.allSettled(this.inflight); }
  close() { this.db.close(); }
  private profile(n: Network): Profile { return this.profiles[n] ?? fail('NETWORK_NOT_CONFIGURED', 'Configure this network and scoped identities on the server.', 503); }
  private event(n: Network, s: Session, kind: string, detail: unknown, tenant: string | null = null) { this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?)').run(randomUUID(), n, iso(this.now()), s.id, tenant, kind, JSON.stringify(detail)); }
  private transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  private account(n: Network, tenant: string): Row { return this.db.prepare('SELECT * FROM accounts WHERE network=? AND tenant=?').get(n, tenant) as Row ?? fail('CUSTOMER_NOT_CONFIGURED', 'Customer is not configured for this network.', 404); }
  private active(n: Network, tenant?: string): Row[] { return (tenant ? this.db.prepare('SELECT * FROM contracts WHERE network=? AND tenant=? AND active=1').all(n, tenant) : this.db.prepare('SELECT * FROM contracts WHERE network=? AND active=1').all(n)).map(r => ({ ...r, payload: JSON.parse(String(r.payload)) })); }
  private set(n: Network, key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?,?) ON CONFLICT(network,key) DO UPDATE SET value=excluded.value').run(n, key, JSON.stringify(value)); }
  private get<T>(n: Network, key: string, fallback: T): T { const r = this.db.prepare('SELECT value FROM settings WHERE network=? AND key=?').get(n, key); return r ? JSON.parse(String(r.value)) : fallback; }
  policy(n: Network, tenant: string, s: Session, input: unknown) {
    operator(s); this.profile(n); this.account(n, tenant); const p = policySchema.parse(input);
    return this.transaction(() => { this.db.prepare('UPDATE accounts SET status=?,limitUsd=?,maxUnits=? WHERE network=? AND tenant=?').run(p.status, p.limitUsd, p.maxAllowanceUnits, n, tenant); this.event(n, s, 'account.policy', p, tenant); return this.account(n, tenant); });
  }
  request(n: Network, s: Session, input: unknown) {
    this.profile(n);
    if (s.role !== 'customer' || !s.tenantId) fail('FORBIDDEN', 'A customer account is required.', 403);
    this.account(n, s.tenantId!);
    const value = z.object({ key: z.string().uuid(), mode: z.enum(['ManagedUsage', 'DirectTopUp']), amount: amount.refine(v => fixed(v) > 0n), reason: z.string().trim().min(3).max(300), recipient: z.object({ company: z.string().trim().min(2).max(100), email: z.string().email().max(254), partyId: z.string().min(10).max(300), validator: z.string().trim().min(3).max(300), ownershipReference: z.string().trim().min(3).max(300) }).strict().optional() }).strict().parse(input);
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM funding_requests WHERE network=? AND tenant=? AND requestKey=?').get(n, s.tenantId!, value.key) as Row | undefined;
      if (old) { if (JSON.stringify(value.recipient ?? null) !== ((this.db.prepare('SELECT body FROM funding_recipients WHERE requestId=?').get(old.id) as Row | undefined)?.body ?? 'null')) fail('IDEMPOTENCY_CONFLICT', 'Recipient changed for the saved request.'); if (old.mode !== value.mode || old.amount !== value.amount || old.reason !== value.reason) fail('IDEMPOTENCY_CONFLICT', 'Request key was used for different input.'); return old; }
      if (this.db.prepare("SELECT id FROM funding_requests WHERE network=? AND tenant=? AND status='pending'").get(n, s.tenantId!)) fail('REQUEST_PENDING', 'Wait for review of your existing request.');
      const id = randomUUID();
      this.db.prepare('INSERT INTO funding_requests VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, n, s.tenantId!, value.key, value.mode, value.amount, value.reason, 'pending', iso(this.now()), null);
      if (value.recipient) this.db.prepare('INSERT INTO funding_recipients VALUES (?,?)').run(id, JSON.stringify(value.recipient));
      this.event(n, s, 'funding.requested', { id, ...value }, s.tenantId);
      return this.db.prepare('SELECT * FROM funding_requests WHERE id=?').get(id);
    });
  }
  reviewRequest(n: Network, s: Session, id: string, input: unknown) {
    operator(s);
    const value = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().min(3).max(300) }).strict().parse(input);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM funding_requests WHERE network=? AND id=?').get(n, id) as Row | undefined;
      if (!row) fail('NOT_FOUND', 'Request not found.', 404);
      if (row!.status !== 'pending') fail('ALREADY_REVIEWED', 'This request already has a decision.');
      const decision = JSON.stringify({ ...value, actor: s.id, at: iso(this.now()) });
      this.db.prepare('UPDATE funding_requests SET status=?,decision=? WHERE id=?').run(value.status, decision, id);
      this.event(n, s, 'funding.reviewed', { id, ...value }, row!.tenant);
      return { id, status: value.status };
    });
  }
  planner(n: Network, s: Session, input: unknown) { operator(s); const value = plannerSchema.parse(input); this.transaction(() => { this.set(n, 'planner', value); this.event(n, s, 'planning.changed', value); }); return value; }
  treasury(n: Network, s: Session, input: unknown) {
    operator(s); const value = z.object({ balanceCc: amount, observedAt: z.string().datetime({ offset: true }), evidenceRef: z.string().trim().min(3).max(300), note: z.string().trim().min(3).max(300) }).strict().parse(input);
    if (Date.parse(value.observedAt) > this.now() || Date.parse(value.observedAt) < this.now() - DAY) fail('STALE_SNAPSHOT', 'Use a treasury observation from the past 24 hours.');
    const record = { ...value, recordedAt: iso(this.now()), recordedBy: s.id, source: 'operator-attested' };
    this.transaction(() => { this.set(n, 'treasury', record); this.event(n, s, 'treasury.observed', record); }); return record;
  }
  async health(n: Network, s: Session) {
    operator(s); const p = this.profile(n);
    try {
      const participant = await this.call(p, p.provider, '/v2/parties/participant-id');
      if (participant.participantId !== p.participantId) fail('WRONG_PARTICIPANT', 'Ledger participant does not match the reviewed network profile.');
      const packages = await this.call(p, p.provider, '/v2/packages');
      if (!Array.isArray(packages.packageIds) || !packages.packageIds.includes(p.packageId)) fail('PACKAGE_MISSING', 'The configured ClearRoute package is not available on this participant.');
      const end = await this.call(p, p.provider, '/v2/state/ledger-end');
      if (!Number.isSafeInteger(end.offset) || end.offset < 0) fail('INVALID_OFFSET', 'Unsupported ledger offset.');
      const result = { status: 'connected', checkedAt: iso(this.now()), offset: String(end.offset), detail: 'Participant and package matched. Native funding capability is not established.' };
      this.set(n, 'health', result); return result;
    } catch (e) { this.set(n, 'health', { status: 'unavailable', checkedAt: iso(this.now()), detail: e instanceof AppError ? e.message : 'Connection check failed.' }); throw e; }
  }
  private assertWrites(n: Network) {
    const p = this.profile(n); if (!p.writesEnabled) fail('WRITES_DISABLED', 'Ledger writes are disabled in the server profile.', 403);
    const health = this.get<Row | null>(n, 'health', null);
    if (!health || health.status !== 'connected' || this.now() - Date.parse(health.checkedAt) > 5 * 60000) fail('CHECK_CONNECTION', 'Run a successful connection check within five minutes before submitting.');
    return p;
  }
  async submit(n: Network, s: Session, key: string, input: unknown): Promise<any> {
    z.string().regex(/^[\w-]{8,150}$/).parse(key); const a = actionSchema.parse(input), fp = hash(a);
    const existing = this.db.prepare('SELECT * FROM commands WHERE network=? AND actor=? AND key=?').get(n, s.id, key) as Row | undefined;
    if (existing) { if (existing.fingerprint !== fp) fail('IDEMPOTENCY_CONFLICT', 'This request key was already used for different input.'); return this.commandView(existing); }
    const p = this.assertWrites(n);
    let tenant: string, payload: Row = {}, template: Template = 'ServiceOffer';
    if (a.action === 'offer') { operator(s); tenant = a.tenantId; }
    else {
      const c = this.db.prepare('SELECT * FROM contracts WHERE network=? AND id=? AND active=1').get(n, a.contractId) as Row | undefined;
      if (!c) fail('CONTRACT_NOT_FOUND', 'Active contract not indexed. Reconcile its ledger update first.', 404);
      tenant = c!.tenant; template = choices[a.action].template;
      if (c!.template !== template) fail('WRONG_TEMPLATE', 'Contract does not support this action.');
      payload = JSON.parse(c!.payload);
      if (choices[a.action].customer) { if (s.role !== 'customer' || s.tenantId !== tenant) fail('CUSTOMER_CONSENT_REQUIRED', 'The customer must authorize this choice.', 403); }
      else operator(s);
    }
    const account = this.account(n, tenant), active = this.active(n, tenant);
    const admitting = ['offer', 'accept', 'allowance', 'job'].includes(a.action);
    if (admitting && account.status !== 'approved') fail('ACCOUNT_PAUSED', 'Account must be approved before new commitments.');
    const bills = active.filter(c => c.template === 'Invoice');
    const outstanding = bills.reduce((sum, c) => sum + c.payload.lines.reduce((t: bigint, l: Row) => t + fixed(l.fixedUsd), 0n) - fixed(c.payload.paidUsd), 0n);
    if (admitting && (outstanding >= fixed(account.limitUsd) || bills.some(c => Date.parse(c.payload.dueAt) < this.now() && fixed(c.payload.paidUsd) < c.payload.lines.reduce((sum: bigint, l: Row) => sum + fixed(l.fixedUsd), 0n)))) fail('CREDIT_BLOCKED', 'Outstanding or overdue invoices block new funding commitments.');
    if (a.action === 'offer' && (fixed(a.exposureLimitUsd) > fixed(account.limitUsd) || BigInt(a.maxAllowanceUnits) > BigInt(account.maxUnits))) fail('LIMIT_EXCEEDED', 'Offer exceeds the approved account policy.');
    if (a.action === 'allowance') {
      const allocated = active.filter(c => c.template === 'UsageAllowance').reduce((v, c) => v + BigInt(c.payload.approvedUnits), 0n);
      if (allocated + BigInt(a.units) > BigInt(account.maxUnits)) fail('LIMIT_EXCEEDED', 'Revoke or settle existing allowances before allocating additional capacity.');
    }
    if (a.action === 'job' && active.some(c => c.template === 'DemoJob')) fail('JOB_IN_FLIGHT', 'Complete and reconcile the existing job before another submission.');
    if (a.action === 'job' && active.some(c => c.template === 'DemoCompletion' && !active.some(u => u.template === 'UsageReceipt' && u.payload.completionRef === c.updateId))) fail('METERING_PENDING', 'Record the completed job usage before another submission.');
    if (a.action === 'usage' && !active.some(c => c.template === 'DemoCompletion' && c.updateId === a.completionRef)) fail('COMPLETION_REQUIRED', 'Usage requires an indexed completion update for this customer.');
    const identity = a.action !== 'offer' && choices[a.action].customer ? p.customers[tenant] : p.provider;
    if (!identity) fail('IDENTITY_MISSING', 'No scoped identity is configured.', 503);
    const id = hash({ network: n, actor: s.id, key });
    let command: unknown;
    if (a.action === 'offer') command = { CreateCommand: { templateId: templateId('ServiceOffer', p.packageId), createArguments: {
      provider: p.provider.partyId, customer: p.customers[tenant].partyId, network: networkValue(n), mode: a.mode, agreementId: a.agreementId,
      terms: { termsRef: a.termsRef, pricingPolicyVersion: a.pricingPolicyVersion, exposureLimitUsd: a.exposureLimitUsd, maxAllowanceUnits: a.maxAllowanceUnits, validUntil: a.validUntil }, acceptBefore: a.acceptBefore,
    } } };
    else { const { action, contractId, ...args } = a; command = { ExerciseCommand: { templateId: templateId(template, p.packageId), contractId, choice: choices[action].choice, choiceArgument: action === 'close' ? { actor: identity.partyId } : args } }; }
    const body = { commands: { commandId: id, userId: identity.userId, actAs: [identity.partyId], synchronizerId: p.synchronizerId, commands: [command] }, transactionFormat: transactionFormat([identity.partyId]) };
    this.transaction(() => {
      if (this.db.prepare("SELECT id FROM commands WHERE network=? AND tenant=? AND status IN ('submitting','uncertain')").get(n, tenant)) fail('PENDING_COMMAND', 'Reconcile the pending command before creating another operation.');
      const refs: [string, string][] = [];
      if (a.action === 'offer') refs.push(['agreement', `${tenant}:${a.agreementId}`]);
      if (a.action === 'allowance') refs.push(['allowance', `${tenant}:${a.allowanceId}`]);
      if (a.action === 'job') refs.push(['job', `${tenant}:${a.jobId}`]);
      if (a.action === 'usage') refs.push(['usage', a.usageRef], ['completion', a.completionRef]);
      if (a.action === 'invoice') {
        const start = Date.parse(a.periodStart), end = Date.parse(a.periodEnd);
        if (end - start !== 15 * DAY || end > this.now() || start < Date.parse(active.find(c => c.id === a.contractId)?.createdAt ?? '9999-01-01')) fail('INVALID_PERIOD', 'Select a closed fifteen-day period after agreement acceptance.');
        if (this.db.prepare("SELECT payload FROM contracts WHERE network=? AND tenant=? AND template='Invoice'").all(n, tenant).some(r => { const b = JSON.parse(String(r.payload)); return Date.parse(b.periodStart) < end && Date.parse(b.periodEnd) > start; })) fail('OVERLAPPING_INVOICE', 'This billing period overlaps an indexed invoice.');
        refs.push(['invoice', `${tenant}:${a.invoiceId}`], ...a.lines.map(l => ['charge', l.chargeRef] as [string, string]));
        if (new Set(a.lines.map(l => l.chargeRef)).size !== a.lines.length) fail('DUPLICATE_CHARGE', 'Invoice contains duplicate charges.');
      }
      if (a.action === 'payment') refs.push(['payment', a.paymentRef]);
      for (const [kind, ref] of refs) { if (this.db.prepare('SELECT commandId FROM business_refs WHERE network=? AND kind=? AND ref=?').get(n, kind, ref)) fail('DUPLICATE_REFERENCE', 'A business reference is already allocated; reconcile the original operation.'); this.db.prepare('INSERT INTO business_refs VALUES (?,?,?,?)').run(n, kind, ref, id); }
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, n, tenant, s.id, identity.userId, key, fp, a.action, JSON.stringify(body), 'submitting', null, null, iso(this.now()));
      this.event(n, s, 'command.prepared', { id, action: a.action }, tenant);
    });
    const work = this.send(n, s, id, p, identity, body); this.inflight.add(work);
    try { return await work; } finally { this.inflight.delete(work); }
  }
  private async send(n: Network, s: Session, id: string, p: Profile, identity: Profile['provider'], body: unknown) {
    try {
      const response = await this.call(p, identity, '/v2/commands/submit-and-wait-for-transaction', body);
      if (response.transaction?.commandId !== id) fail('COMMAND_MISMATCH', 'Returned transaction does not match the recorded command.');
      this.ingest(n, response.transaction, s, id);
    } catch (e) {
      this.db.prepare("UPDATE commands SET status='uncertain',error=? WHERE id=? AND status='submitting'").run(e instanceof AppError ? e.message : 'Response could not be verified. Reconcile the recorded command.', id);
    }
    return this.commandView(this.db.prepare('SELECT * FROM commands WHERE id=?').get(id) as Row);
  }
  private commandView(r: Row) { return { id: r.id, network: r.network, tenant: r.tenant, action: r.action, status: r.status, result: r.result ? JSON.parse(r.result) : null, error: r.error, createdAt: r.createdAt }; }
  async reconcile(n: Network, s: Session, updateId: string, commandId?: string) {
    operator(s); z.string().min(1).max(300).parse(updateId); const p = this.profile(n);
    let identity = p.provider;
    if (commandId) { const c = this.db.prepare('SELECT * FROM commands WHERE network=? AND id=?').get(n, commandId) as Row | undefined; if (!c) fail('NOT_FOUND', 'Command not found.', 404); identity = [p.provider, ...Object.values(p.customers)].find(i => i.userId === c!.userId) ?? fail('IDENTITY_MISSING', 'Original identity is unavailable.'); }
    const response = await this.call(p, identity, '/v2/updates/update-by-id', { updateId, updateFormat: { includeTransactions: transactionFormat([identity.partyId]) } });
    const tx = response.update?.Transaction?.value;
    if (tx?.updateId !== updateId || (commandId && tx?.commandId !== commandId)) fail('EVIDENCE_MISMATCH', 'Ledger evidence does not match the requested update/command.');
    this.ingest(n, tx, s, commandId); return { updateId, recorded: true };
  }
  private ingest(n: Network, tx: any, s: Session, commandId?: string) {
    const p = this.profile(n);
    if (!tx || !Array.isArray(tx.events) || typeof tx.updateId !== 'string' || !Number.isSafeInteger(tx.offset) || !Number.isFinite(Date.parse(tx.recordTime)) || tx.synchronizerId !== p.synchronizerId) fail('INVALID_EVIDENCE', 'Transaction identity, offset, time or synchronizer is invalid.');
    if (commandId) {
      const command = this.db.prepare('SELECT * FROM commands WHERE network=? AND id=?').get(n, commandId) as Row;
      const expected: Record<string, Template[]> = { offer: ['ServiceOffer'], accept: ['ServiceAgreement'], allowance: ['UsageAllowance'], job: ['DemoJob'], complete: ['DemoCompletion'], usage: ['UsageAllowance', 'UsageReceipt'], invoice: ['Invoice'], payment: ['Invoice', 'PaymentReceipt'], dispute: ['InvoiceDispute'] };
      if ((expected[command.action] ?? []).some(name => !tx.events.some((e: any) => e.CreatedEvent?.templateId === templateId(name, p.packageId)))) fail('INCOMPLETE_EVIDENCE', 'Expected contract results are missing from the ledger response.');
      const exercise = JSON.parse(command.body).commands.commands[0].ExerciseCommand;
      if (exercise && !['allowance', 'job', 'invoice', 'dispute'].includes(command.action) && !tx.events.some((e: any) => e.ArchivedEvent?.contractId === exercise.contractId)) fail('INCOMPLETE_EVIDENCE', 'Expected consuming choice archive is missing.');
    }
    this.transaction(() => {
      const prior = this.db.prepare('SELECT body FROM updates WHERE network=? AND id=?').get(n, tx.updateId);
      if (prior && hash(JSON.parse(String(prior.body))) !== hash(tx)) fail('EVIDENCE_CONFLICT', 'An update ID returned different content.');
      if (!prior) {
        const last = this.db.prepare('SELECT MAX(CAST(offset AS INTEGER)) AS value FROM updates WHERE network=?').get(n) as Row;
        if (last.value !== null && tx.offset <= last.value) fail('OUT_OF_ORDER', 'Import updates in ascending offset order to preserve contract state.');
        for (const event of tx.events) {
          const archived = event.ArchivedEvent;
          if (archived) this.db.prepare('UPDATE contracts SET active=0 WHERE network=? AND id=?').run(n, archived.contractId);
          const created = event.CreatedEvent; if (!created) continue;
          const template = (Object.keys(modules) as Template[]).find(t => created.templateId === templateId(t, p.packageId));
          if (!template) continue;
          const payload = created.createArgument;
          const tenant = Object.keys(p.customers).find(t => p.customers[t].partyId === payload?.customer) ?? fail('FOREIGN_CUSTOMER', 'Customer is outside the configured party bindings.');
          if (!tenant || payload.provider !== p.provider.partyId || payload.network !== networkValue(n) || typeof created.contractId !== 'string') fail('FOREIGN_CONTRACT', 'Contract is outside the configured network/provider/customer bindings.');
          this.db.prepare('INSERT INTO contracts VALUES (?,?,?,?,?,1,?,?)').run(n, created.contractId, tenant, template, JSON.stringify(payload), tx.recordTime, tx.updateId);
          const metric = (kind: string, ref: string, value: string) => {
            fixed(value); const old = this.db.prepare('SELECT * FROM metrics WHERE network=? AND kind=? AND ref=?').get(n, kind, ref) as Row | undefined;
            if (old && (old.tenant !== tenant || fixed(old.amount) !== fixed(value))) fail('METRIC_CONFLICT', 'Duplicate business reference has conflicting ledger evidence.');
            if (!old) this.db.prepare('INSERT INTO metrics VALUES (?,?,?,?,?,?,?)').run(n, kind, ref, tenant, tx.recordTime, value, tx.updateId);
          };
          if (template === 'Invoice') metric('invoicedUsd', `${tenant}:${payload.invoiceId}`, display(payload.lines.reduce((sum: bigint, line: Row) => sum + fixed(line.fixedUsd), 0n)));
          if (template === 'PaymentReceipt') metric('collectedUsd', payload.paymentRef, payload.settledUsd);
          if (template === 'FundingReceipt') metric('burnedCc', payload.nativePurchaseRef, payload.actualCcBurned);
          if (template === 'TopUpReceipt') metric('transferredCc', payload.nativeTransferRef, payload.recipientCc);
          if (template === 'UsageReceipt') metric('usageUnits', payload.usageRef, String(payload.measuredUnits));
        }
        this.db.prepare('INSERT INTO updates VALUES (?,?,?,?,?)').run(n, tx.updateId, String(tx.offset), tx.recordTime, JSON.stringify(tx));
        this.event(n, s, 'ledger.indexed', { updateId: tx.updateId, offset: tx.offset });
      }
      if (commandId) this.db.prepare("UPDATE commands SET status='confirmed',result=?,error=NULL WHERE network=? AND id=?").run(JSON.stringify({ updateId: tx.updateId, offset: String(tx.offset) }), n, commandId);
    });
  }
  state(n: Network, s: Session) {
    if (s.role === 'customer' && !s.tenantId) fail('FORBIDDEN', 'Customer tenant required.', 403);
    const tenant = s.role === 'customer' ? s.tenantId : null;
    const allowed = <T extends Row>(rows: T[]) => tenant ? rows.filter(r => r.tenant === tenant) : rows;
    const contracts = this.active(n, tenant ?? undefined);
    const accounts = allowed(this.db.prepare('SELECT * FROM accounts WHERE network=?').all(n) as Row[]);
    const commands = allowed(this.db.prepare('SELECT * FROM commands WHERE network=? ORDER BY createdAt DESC').all(n) as Row[]).slice(0, 100).map(r => this.commandView(r));
    const audit = allowed(this.db.prepare('SELECT * FROM audit WHERE network=? ORDER BY at DESC').all(n) as Row[]).slice(0, 100).map(r => ({ ...r, detail: JSON.parse(r.detail) }));
    return { network: n, configured: !!this.profiles[n], writesEnabled: !!this.profiles[n]?.writesEnabled,
      health: this.get(n, 'health', { status: 'unchecked', checkedAt: null, detail: 'Run a connection check before submitting.' }),
      accounts, contracts, commands, audit, requests: allowed(this.db.prepare('SELECT * FROM funding_requests WHERE network=? ORDER BY createdAt DESC').all(n) as Row[]).slice(0, 100), recipients: allowed(this.db.prepare('SELECT r.tenant,r.network,f.requestId,f.body FROM funding_recipients f JOIN funding_requests r ON r.id=f.requestId WHERE r.network=?').all(n) as Row[]).map(r => ({ requestId: r.requestId, ...JSON.parse(r.body) })), analytics: s.role === 'operator' ? this.analytics(n) : null,
      capabilities: { serviceContracts: !!this.profiles[n], nativeTransfers: false, trafficPurchases: false, balance: 'operator-attested' },
      packageName: 'clearroute-service', packageId: this.profiles[n]?.packageId ?? null,
    };
  }
  analytics(n: Network) {
    const now = new Date(this.now()), currentMonth = iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).slice(0, 7);
    const months = Array.from({ length: 12 }, (_, i) => iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).slice(0, 7));
    const rows = this.db.prepare('SELECT * FROM metrics WHERE network=?').all(n) as Row[];
    const monthly = months.map(month => {
      const inMonth = rows.filter(r => r.at.slice(0, 7) === month);
      const total = (kind: string) => display(inMonth.filter(r => r.kind === kind).reduce((sum, r) => sum + fixed(r.amount), 0n));
      return { month, invoicedUsd: total('invoicedUsd'), collectedUsd: total('collectedUsd'), burnedCc: total('burnedCc'), transferredCc: total('transferredCc'), usageUnits: total('usageUnits'), records: inMonth.length };
    });
    const settings = this.get(n, 'planner', { growthPercent: 20, reserveDays: 30, leadDays: 7, minimumCc: '0' });
    const sample = monthly.slice(-4, -1), sampleTotal = sample.reduce((sum, m) => sum + fixed(m.burnedCc) + fixed(m.transferredCc), 0n);
    const avg = sampleTotal / 3n, forecast = (avg * BigInt(100 + settings.growthPercent) + 99n) / 100n;
    const reserve = (forecast * BigInt(settings.reserveDays + settings.leadDays) + 29n) / 30n;
    const target = forecast + reserve > fixed(settings.minimumCc) ? forecast + reserve : fixed(settings.minimumCc);
    const snapshot = this.get<Row | null>(n, 'treasury', null);
    const fresh = !!snapshot && this.now() - Date.parse(snapshot.observedAt) <= DAY;
    const balance = fresh ? fixed(snapshot!.balanceCc) : null;
    const observedMonths = sample.filter(m => fixed(m.burnedCc) + fixed(m.transferredCc) > 0n).length;
    const acquisition = balance === null || observedMonths < 3 ? null : target > balance ? target - balance : 0n;
    const current = monthly.at(-1)!, previous = monthly.at(-2)!;
    const growth = fixed(previous.invoicedUsd) === 0n ? null : Number((fixed(current.invoicedUsd) - fixed(previous.invoicedUsd)) * 10000n / fixed(previous.invoicedUsd)) / 100;
    return { monthly, currentMonth, currentMonthPartial: true, growthPercent: growth, settings,
      treasury: snapshot ? { ...snapshot, stale: !fresh } : null,
      forecast: { baselineCc: display(avg), nextMonthCc: display(forecast), targetCc: display(target), suggestedPurchaseCc: acquisition === null ? null : display(acquisition), runwayDays: balance === null || avg === 0n ? null : Number(balance * 30n / avg), observedMonths, source: 'Trailing three complete UTC calendar months; missing indexed months count as zero. Procurement estimate requires consumption in all three months and a fresh balance. Consumption combines attested burn and transfers, not token price.' },
      provenance: 'Indexed ClearRoute ledger attestations only. CC burn and settlement attestations are not independently verified native events. Current month is partial.',
    };
  }
}
