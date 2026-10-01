import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, request } from './api';
import type { Session } from './types';

type Payment = { id: string; amountUsd: string; reference: string; status: string };
type Invoice = { id: string; tenant: string; totalUsd: string; outstandingUsd: string; status: string; periodStart: string; periodEnd: string; payments: Payment[] };
type Preview = { id: string; tenant: string; periodStart: string; periodEnd: string; totalUsd: string };
type BillingState = { now: string; invoices: Invoice[]; lateUsage: { id: string; invoiceId: string }[]; audit: { id: string; kind: string; at: string }[] };
type Operation = { key: string; path: string; body: Record<string, unknown> };
const storageKey = 'clearroute.billing.pending.operator';

function savedOperation(): Operation | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return value && typeof value.key === 'string' && typeof value.path === 'string' && value.path.startsWith('/api/billing/') && value.body && typeof value.body === 'object' ? value : null;
  } catch { return null; }
}

export default function Billing({ session }: { session: Session }) {
  const [state, setState] = useState<BillingState | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Operation | null>(savedOperation);
  const lock = useRef(false);
  const operator = session === 'operator';
  const disabled = busy || !!pending;

  async function refresh(signal?: AbortSignal) {
    const [billing, measured] = await Promise.all([
      request<BillingState>(session, '/api/billing', { signal }),
      request<{ invoices: Preview[] }>(session, '/api/metering', { signal }),
    ]);
    if (!signal?.aborted) { setState(billing); setPreviews(measured.invoices); setError(''); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => controller.abort();
  }, [session]);

  async function mutate(path: string, body: Record<string, unknown>, retry?: Operation) {
    if (!operator || lock.current || (pending && !retry)) return;
    lock.current = true; setBusy(true); setError('');
    const operation = retry || { path, body, key: crypto.randomUUID() };
    try {
      // Persist before submitting; uncertain responses must reuse the exact request.
      localStorage.setItem(storageKey, JSON.stringify(operation)); setPending(operation);
      await request(session, operation.path, { body: operation.body, key: operation.key });
      localStorage.removeItem(storageKey); setPending(null);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) { localStorage.removeItem(storageKey); setPending(null); }
      setError(e instanceof Error ? e.message : 'The response could not be verified.');
    } finally { lock.current = false; setBusy(false); }
  }
  function payment(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutate(`/api/billing/invoices/${encodeURIComponent(id)}/payments`, { amountUsd: data.get('amount'), reference: data.get('reference'), rail: 'sandbox_usd' });
  }
  function reconcile(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void mutate(`/api/billing/payments/${encodeURIComponent(id)}/reconcile`, { decision: data.get('decision'), note: data.get('note') });
  }
  async function download(id: string) {
    try {
      const invoice = await request(session, `/api/billing/invoices/${encodeURIComponent(id)}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(invoice, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${id}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(e instanceof Error ? e.message : 'Export failed.'); }
  }
  return <div className="localnet-workspace">
    <section className="card localnet-intro"><h2>Measured billing</h2><p>Sandbox invoices are not payable. Payment records simulate USD settlement.</p>
      {error && <p role="alert">{error}</p>}
      {!state && !error && <p role="status">Loading billing…</p>}
      <button className="button secondary" disabled={busy} onClick={() => void refresh().catch(e => setError(e.message))}>Refresh billing</button>
      {operator && <button className="button secondary" disabled={disabled || !state} onClick={() => void mutate('/api/billing/clock/advance', { days: 15 })}>Advance sandbox clock 15 days</button>}
      {operator && pending && <p>Request awaiting verification. <button className="button" disabled={busy} onClick={() => void mutate(pending.path, pending.body, pending)}>Retry saved operation</button></p>}
      {state && <p>Billing clock: {state.now}</p>}
    </section>
    {operator && <section className="card"><h2>Review invoice previews</h2>{!previews.length && <p>Create a preview in Measured usage first.</p>}{previews.map(preview => <article className="localnet-run" key={preview.id}><h3>{preview.tenant} · {preview.totalUsd} USD</h3><p>{preview.periodStart} to {preview.periodEnd}</p><code>{preview.id}</code><button className="button" disabled={disabled || !state || Date.parse(preview.periodEnd) > Date.parse(state.now) || state.invoices.some(i => i.tenant === preview.tenant && i.periodStart === preview.periodStart)} onClick={() => void mutate('/api/billing/finalize', { tenantId: preview.tenant, periodStart: preview.periodStart, previewId: preview.id })}>Finalize reviewed preview</button></article>)}</section>}
    <section className="card"><h2>Finalized invoices</h2>{state && !state.invoices.length && <p>No finalized invoices.</p>}{state?.invoices.map(invoice => <article className="localnet-run" key={invoice.id}><h3>{invoice.tenant} · {invoice.totalUsd} USD · {invoice.status}</h3><code>{invoice.id}</code><p>Outstanding: {invoice.outstandingUsd} USD</p><button className="button secondary" onClick={() => void download(invoice.id)}>Export invoice</button>
      {operator && invoice.outstandingUsd !== '0.00' && <form onSubmit={e => payment(e, invoice.id)}><label className="field">Payment amount USD<input name="amount" required pattern="[0-9]+(\.[0-9]{1,6})?" inputMode="decimal" /></label><label className="field">Payment reference<input name="reference" required minLength={4} maxLength={120} /></label><button className="button" disabled={disabled}>Record sandbox payment</button></form>}
      {invoice.payments.map(p => <div key={p.id}><p>{p.reference} · {p.amountUsd} USD · {p.status}</p>{operator && ['pending', 'confirmed'].includes(p.status) && <form onSubmit={e => reconcile(e, p.id)}><label className="field">Decision<select name="decision">{p.status === 'confirmed' ? <option value="reversed">Reverse</option> : <><option value="confirmed">Confirm</option><option value="rejected">Reject</option></>}</select></label><label className="field">Reconciliation note<input name="note" required maxLength={240} /></label><button className="button" disabled={disabled}>Reconcile payment</button></form>}</div>)}
    </article>)}</section>
    <section className="card"><h2>Late usage requiring review</h2>{state?.lateUsage.map(row => <p key={row.id}>{row.id} · {row.invoiceId}</p>)}{state && !state.lateUsage.length && <p>No late usage.</p>}</section>
    <section className="card"><h2>Billing audit</h2>{state?.audit.map(event => <p key={event.id}>{event.at} · {event.kind}</p>)}</section>
  </div>;
}
