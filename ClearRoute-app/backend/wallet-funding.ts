import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AppError, decimal, format } from './money.js';
import { WalletApiError } from './wallet-adapter.js';

export type WalletIdentity = { user: string; party: string; balanceCc: string };
export type FundingBinding = { sender: WalletIdentity; receiver: WalletIdentity; domain: string };
export type NativeOffer = { receiver_party_id: string; amount: string; description: string; expires_at: number; tracking_id: string };
export type FundingDependencies = {
  binding(tenant: string): Promise<FundingBinding>;
  create(binding: FundingBinding, request: NativeOffer): Promise<unknown>;
  status(binding: FundingBinding, id: string): Promise<unknown>;
  accept(binding: FundingBinding, contractId: string): Promise<unknown>;
  evidence(binding: FundingBinding, transactionId: string): Promise<any>;
};
const nativeStatus = z.union([
  z.object({ status: z.enum(['created', 'accepted', 'completed']), contract_id: z.string().min(1), transaction_id: z.string().min(1) }),
  z.object({ status: z.literal('failed'), failure_kind: z.enum(['expired', 'rejected', 'withdrawn']) }),
]);
const UNITS = 10_000_000_000n;
export function nativeAmount(value: unknown) { return decimal(value, 10, 100n); }

// A wallet status or a balance difference alone is not proof of delivery.
export function fundingReceipt(evidence: any, binding: FundingBinding, request: NativeOffer, status: { transaction_id: string; contract_id: string }) {
  const tx = evidence?.transaction;
  if (tx?.updateId !== status.transaction_id) throw new Error('Transfer transaction ID mismatch.');
  if (tx.synchronizerId !== binding.domain) throw new Error('Transfer synchronizer mismatch.');
  const completed = (tx.events ?? []).map((e: any) => e.ExercisedEvent).filter((e: any) =>
    e?.templateId?.endsWith(':Splice.Wallet.TransferOffer:AcceptedTransferOffer') &&
    e.choice === 'AcceptedTransferOffer_Complete' && e.exerciseResult?.trackingInfo?.trackingId === request.tracking_id);
  if (completed.length !== 1) throw new Error('Matching native transfer completion is missing or ambiguous.');
  const result = completed[0].exerciseResult;
  if (result.trackingInfo.sender !== binding.sender.party || result.trackingInfo.receiver !== binding.receiver.party ||
      !result.transferResult?.createdAmulets?.some((p: any) => p.value === status.contract_id) &&
      !result.createdAmulets?.some((p: any) => p.value === status.contract_id))
    throw new Error('Native completion does not match sender, receiver or delivered coin.');
  const coins = (tx.events ?? []).map((e: any) => e.CreatedEvent).filter((e: any) => e?.contractId === status.contract_id && e.templateId?.endsWith(':Splice.Amulet:Amulet'));
  if (coins.length !== 1 || coins[0].createArgument?.owner !== binding.receiver.party || nativeAmount(coins[0].createArgument?.amount?.initialAmount) !== nativeAmount(request.amount))
    throw new Error('Delivered coin does not match the requested recipient and exact amount.');
  return { transactionId: tx.updateId, contractId: status.contract_id, sender: binding.sender.party, receiver: binding.receiver.party, amountCc: request.amount, trackingId: request.tracking_id, synchronizerId: binding.domain, recordTime: tx.recordTime };
}

type Row = Record<string, any>;
export class WalletFunding {
  private db: DatabaseSync;
  private busy = new Set<string>();
  constructor(directory: string, private deps: FundingDependencies) {
    this.db = new DatabaseSync(path.join(directory, 'wallet-funding.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wallet_funding(id TEXT PRIMARY KEY, tenant TEXT NOT NULL, requestKey TEXT UNIQUE NOT NULL, amount TEXT NOT NULL, binding TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, consentAt TEXT, response TEXT, receipt TEXT, error TEXT);
    `);
  }
  close() { this.db.close(); }
  private row(id: string) { const r = this.db.prepare('SELECT * FROM wallet_funding WHERE id=?').get(id) as Row | undefined; if (!r) throw new AppError('NOT_FOUND', 'Transfer not found.', 404); return r; }
  private view(r: Row) { const binding: FundingBinding = JSON.parse(r.binding); return { id: String(r.id), tenant: String(r.tenant), amountCc: String(r.amount), sender: binding.sender.party, receiver: binding.receiver.party, status: String(r.status), createdAt: String(r.createdAt), consentAt: r.consentAt as string | null, response: r.response ? JSON.parse(r.response) : null, receipt: r.receipt ? JSON.parse(r.receipt) : null, error: r.error as string | null }; }
  get(id: string, tenant?: string) { const row = this.row(id); if (tenant && row.tenant !== tenant) throw new AppError('NOT_FOUND', 'Transfer not found.', 404); return this.view(row); }
  list(tenant?: string) { return (this.db.prepare('SELECT * FROM wallet_funding' + (tenant ? ' WHERE tenant=?' : '') + ' ORDER BY createdAt DESC').all(...(tenant ? [tenant] : [])) as Row[]).map(r => this.view(r)); }
  async state(tenant?: string) {
    const wallets = await Promise.all((tenant ? [tenant] : ['atlas', 'nova']).map(async id => {
      try { const b = await this.deps.binding(id); return { tenant: id, party: b.receiver.party, balanceCc: b.receiver.balanceCc, treasury: tenant ? undefined : b.sender, domain: b.domain, error: null }; }
      catch (e) { return { tenant: id, error: e instanceof Error ? e.message : 'Wallet unavailable' }; }
    }));
    return { network: 'LocalNet', maxTransferCc: '100', totalLimitCc: '1000', wallets, transfers: this.list(tenant) };
  }
  async offer(tenant: string, amount: string, key: string, recipientPartyId?: string) {
    if (!['atlas', 'nova'].includes(tenant)) throw new AppError('INVALID_TENANT', 'Select a configured customer.');
    if (!/^[\w-]{8,150}$/.test(key)) throw new AppError('IDEMPOTENCY_REQUIRED', 'A stable transfer request key is required.');
    const normalized = format(nativeAmount(amount), 10);
    const replay = () => this.db.prepare('SELECT * FROM wallet_funding WHERE requestKey=?').get(key) as Row | undefined;
    const check = (r: Row) => { if (r.tenant !== tenant || r.amount !== normalized) throw new AppError('IDEMPOTENCY_CONFLICT', 'The saved transfer key has a different recipient or amount.', 409); return this.view(r); };
    const existing = replay(); if (existing) return check(existing);
    const binding = await this.deps.binding(tenant);
    if (recipientPartyId && recipientPartyId !== binding.receiver.party) throw new AppError('RECIPIENT_NOT_CONFIGURED', 'This party is not the configured LocalNet treasury wallet. Run wallet:setup for a newly created treasury party.');
    if (binding.sender.party === binding.receiver.party) throw new AppError('INVALID_RECIPIENT', 'Treasury and recipient must be different parties.');
    // Balance is indicative; wallet automation remains authoritative about fees and concurrent spending.
    if (!/^\d+(\.\d{1,10})?$/.test(binding.sender.balanceCc) || !/[1-9]/.test(binding.sender.balanceCc)) throw new AppError('INSUFFICIENT_FUNDS', 'The treasury wallet has no unlocked test CC.');
    const id = `cc-${randomUUID()}`, createdAt = new Date().toISOString();
    const request: NativeOffer = { receiver_party_id: binding.receiver.party, amount: normalized, description: `ClearRoute LocalNet funding ${id}`, expires_at: (Date.now() + 30 * 60_000) * 1000, tracking_id: id };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = replay(); if (prior) { const result = check(prior); this.db.exec('COMMIT'); return result; }
      if (this.db.prepare("SELECT id FROM wallet_funding WHERE status NOT IN ('completed','failed')").get()) throw new AppError('TRANSFER_PENDING', 'Reconcile the existing transfer before spending again.', 409);
      const used = (this.db.prepare("SELECT amount FROM wallet_funding WHERE status!='failed'").all() as Row[]).reduce((sum, r) => sum + nativeAmount(r.amount), 0n);
      if (used + nativeAmount(normalized) > 1000n * UNITS) throw new AppError('LOCAL_LIMIT', 'The 1000 CC LocalNet funding limit has been reached.');
      this.db.prepare('INSERT INTO wallet_funding(id,tenant,requestKey,amount,binding,request,status,createdAt) VALUES (?,?,?,?,?,?,?,?)').run(id, tenant, key, normalized, JSON.stringify(binding), JSON.stringify(request), 'queued', createdAt);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    await this.reconcile(id); return this.get(id);
  }
  async accept(id: string, tenant: string) {
    this.get(id, tenant);
    this.db.prepare("UPDATE wallet_funding SET consentAt=COALESCE(consentAt,?) WHERE id=? AND status NOT IN ('completed','failed')").run(new Date().toISOString(), id);
    await this.reconcile(id); return this.get(id, tenant);
  }
  private update(id: string, status: string, response: unknown) { this.db.prepare('UPDATE wallet_funding SET status=?,response=?,error=NULL WHERE id=?').run(status, JSON.stringify(response), id); }
  async reconcile(id: string) {
    const row = this.row(id);
    if (this.busy.has(id) || ['completed', 'failed'].includes(row.status)) return;
    this.busy.add(id);
    try {
      const binding: FundingBinding = JSON.parse(row.binding), request: NativeOffer = JSON.parse(row.request);
      const current = await this.deps.binding(row.tenant);
      for (const role of ['sender', 'receiver'] as const) if (current[role].party !== binding[role].party || current[role].user !== binding[role].user) throw new Error('Wallet identity changed. Original transfer remains blocked for reconciliation.');
      if (current.domain !== binding.domain) throw new Error('Synchronizer changed. Retaining original transfer.');
      let raw: unknown;
      try { raw = row.status === 'verifying' ? JSON.parse(row.response) : await this.deps.status(binding, id); }
      catch (e) {
        if (!(e instanceof WalletApiError) || e.status !== 404) throw e;
        // A 404 can mean history was pruned. Once any offer was observed, NEVER recreate it.
        if (row.response || row.attempts >= 3 || request.expires_at <= Date.now() * 1000) throw new Error('Transfer status unknown. Do not create a replacement; investigate this tracking ID.');
        this.db.prepare("UPDATE wallet_funding SET status='submitting',attempts=attempts+1 WHERE id=?").run(id);
        await this.deps.create(binding, request);
        this.update(id, 'awaiting_acceptance', { submitted: true });
        return;
      }
      const status = nativeStatus.parse(raw);
      if (status.status === 'failed') { this.update(id, 'failed', status); return; }
      if (status.status === 'completed') {
        this.update(id, 'verifying', status);
        const receipt = fundingReceipt(await this.deps.evidence(binding, status.transaction_id), binding, request, status);
        this.db.prepare("UPDATE wallet_funding SET status='completed',receipt=?,error=NULL WHERE id=?").run(JSON.stringify(receipt), id);
        return;
      }
      this.update(id, status.status === 'accepted' ? 'accepted' : 'awaiting_acceptance', status);
      if (status.status === 'created' && this.row(id).consentAt) {
        await this.deps.accept(binding, status.contract_id);
        // A lost acceptance response is recovered from status, never with a new offer.
        this.update(id, 'accepting', status);
      }
    } catch (e) {
      this.db.prepare("UPDATE wallet_funding SET error=?,status=CASE WHEN status='verifying' THEN status ELSE 'reconciling' END WHERE id=?").run(e instanceof Error ? e.message : 'Transfer result unavailable.', id);
    } finally { this.busy.delete(id); }
  }
  async tick() { for (const row of this.list().filter(r => !['completed', 'failed'].includes(r.status))) await this.reconcile(row.id); }
}
