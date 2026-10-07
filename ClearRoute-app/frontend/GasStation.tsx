import { useAccountStorage } from './account-storage';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Session } from './types';

type Policy = { tenant: string; enabled: boolean; batchBytes: number; capacityLimitBytes: number; remainingCapacityBytes: number; binding: { party: string; validator: string; domain: string } };
type SponsoredRequest = { id: string; tenant: string; status: string; bytes: number; createdAt: string; error: string | null; purchase: { id: string; response?: { transaction_id?: string }; evidence?: { purchase?: { burnedCc: string } } } | null; run: { id: string; steps: { name: string; updateId: string }[] } | null; measurement: { bytes: number; chargeUsd: string } | null };
type State = { policies: Policy[]; requests: SponsoredRequest[]; audit: { id: string; at: string; kind: string }[] };
type Pending = { tenantId: string; key: string };

export default function GasStation({ session }: { session: Session }) {
  const storage = useAccountStorage();
  const [state, setState] = useState<State | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [tenant, setTenant] = useState<string>(session === 'operator' ? 'atlas' : session);
  const storageKey = `clearroute.sponsor.pending.${session}`;
  const [pending, setPending] = useState<Pending | null>(() => { try { const p = JSON.parse(storage.getItem(storageKey) || 'null'); return p && ['atlas','nova'].includes(p.tenantId) && typeof p.key === 'string' ? p : null; } catch { return null; } });
  const lock = useRef(false);
  const operator = session === 'operator';
  const policy = state?.policies.find(p => p.tenant === tenant);
  async function refresh(signal?: AbortSignal) { const result = await request<State>(session, '/api/sponsorship', { signal }); if (!signal?.aborted) setState(result); }
  useEffect(() => { const c = new AbortController(); const update = () => void refresh(c.signal).catch(e => { if (!c.signal.aborted) setError(e.message); }); update(); const timer = setInterval(update, 5000); return () => { c.abort(); clearInterval(timer); }; }, [session]);
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try { await request(session, `/api/sponsorship/policies/${tenant}`, { body: { enabled: data.get('enabled') === 'on', batchBytes: Number(data.get('batch')), capacityLimitBytes: Number(data.get('limit')) } }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Approval failed.'); } finally { lock.current = false; setBusy(false); }
  }
  async function submit() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const operation = pending || { tenantId: tenant, key: crypto.randomUUID() };
    try {
      storage.setItem(storageKey, JSON.stringify(operation)); setPending(operation);
      await request(session, '/api/sponsorship/requests', { key: operation.key, body: { tenantId: operation.tenantId } });
      storage.removeItem(storageKey); setPending(null); await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) { storage.removeItem(storageKey); setPending(null); }
      setError(e instanceof Error ? e.message : 'Outcome unknown. Retry the saved request.');
    } finally { lock.current = false; setBusy(false); }
  }
  async function reconcile(id: string) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await request(session, `/api/sponsorship/requests/${encodeURIComponent(id)}/reconcile`, { body: {} }); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Reconciliation failed.'); } finally { lock.current = false; setBusy(false); }
  }
  const unresolved = state?.requests.some(r => r.tenant === tenant && !['completed','funding_failed'].includes(r.status));
  return <div className="localnet-workspace">
    <section className="card localnet-intro"><span className="eyebrow">LOCALNET SPONSORED EXECUTION</span><h2>Fund and execute an application workflow</h2><p>ClearRoute buys a fresh batch of shared validator traffic with the provider wallet’s test CC, verifies the purchase, executes the application workflow, and reconciles customer usage.</p><p>Supported connector: Atlas and Nova on the provider participant, using the existing service-contract workflow. Capacity is shared; purchased bytes are not a per-party balance or a guaranteed transaction cost.</p>
      {error && <p role="alert" className="localnet-error">{error}</p>}{!state && !error && <p role="status">Loading sponsorship…</p>}
      {operator && <label className="field">Application<select value={tenant} disabled={busy || !!pending} onChange={e => setTenant(e.target.value)}><option value="atlas">Atlas Labs</option><option value="nova">Nova Markets</option></select></label>}
      <button className="button secondary" disabled={busy} onClick={() => { setError(''); void refresh().catch(e => setError(e.message)); }}>Refresh sponsorship</button>
    </section>
    <section className="card"><h2>Sponsorship approval</h2>{policy ? <><p>{policy.enabled ? 'Approved' : 'Paused'} · {policy.remainingCapacityBytes.toLocaleString()} capacity bytes available under the sponsorship allowance.</p><p>Application party</p><code className="traffic-id">{policy.binding.party}</code><p>Funded validator</p><code className="traffic-id">{policy.binding.validator}</code><p>Synchronizer</p><code className="traffic-id">{policy.binding.domain}</code></> : <p>This application has no approved sponsorship policy.</p>}
      {operator && <form key={`${tenant}:${policy?.batchBytes}:${policy?.capacityLimitBytes}:${policy?.enabled}`} onSubmit={approve}><label className="field">Traffic bytes per request<input name="batch" type="number" min="200000" max="1000000" step="1" defaultValue={policy?.batchBytes || 200000} required /></label><label className="field">Total capacity allowance bytes<input name="limit" type="number" min="200000" max="10000000" step="1" defaultValue={policy?.capacityLimitBytes || 200000} required /></label><label className="checkbox"><input name="enabled" type="checkbox" defaultChecked={policy?.enabled || false} />Authorize spending provider test CC for this application</label><p>The allowance limits purchased bytes, not CC price. The network determines CC cost at execution. Pending requests reserve their full batch; successful purchases remain counted even if the application transaction fails.</p><button className="button" disabled={busy}>Save sponsorship policy</button></form>}
    </section>
    <section className="card"><h2>Sponsored request</h2><p>Each request uses the approved traffic batch and runs the five-step service workflow. This writes contracts and spends LocalNet test CC. A verified purchase is required before submission.</p><button className="button" disabled={busy || (!pending && (!policy?.enabled || !!unresolved || policy.remainingCapacityBytes < policy.batchBytes))} onClick={() => void submit()}>{busy ? 'Processing…' : pending ? 'Retry saved sponsorship request' : 'Fund and run workflow'}</button>{pending && <p>A response is unverified. Retrying preserves the original request identifier.</p>}</section>
    <section className="card"><h2>Sponsorship history</h2>{state && !state.requests.length && <p>No sponsored requests yet.</p>}{state?.requests.map(r => <article className="localnet-run" key={r.id}><h3>{r.tenant} · {r.status.replaceAll('_',' ')}</h3><code>{r.id}</code><p>Capacity batch: {r.bytes.toLocaleString()} bytes</p>{r.error && <p className="localnet-error">{r.error}</p>}{r.purchase && <><p>Traffic purchase: {r.purchase.id}</p><code className="traffic-id">{r.purchase.response?.transaction_id || 'Awaiting wallet confirmation'}</code>{r.purchase.evidence?.purchase && <p>Verified purchase burn: {r.purchase.evidence.purchase.burnedCc} test CC</p>}</>}{r.run?.steps.map(s => <p key={s.updateId}>{s.name}<code className="traffic-id">{s.updateId}</code></p>)}{r.measurement && <p>Verified customer traffic: {r.measurement.bytes.toLocaleString()} bytes · fixture charge {r.measurement.chargeUsd} USD (not payable). View Measured usage and Billing for invoice previews.</p>}{!['completed','funding_failed'].includes(r.status) && <button className="button secondary" disabled={busy} onClick={() => void reconcile(r.id)}>Check saved request</button>}</article>)}</section>
    {operator && <section className="card"><h2>Sponsorship audit</h2>{state?.audit.map(e => <p key={e.id}>{e.at} · {e.kind}</p>)}</section>}
  </div>;
}
