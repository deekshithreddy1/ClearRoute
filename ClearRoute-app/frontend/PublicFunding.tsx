import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { BrandLogo, DnaArt } from './Brand';
import './operations.css';
import './public-funding.css';

export const fundingRecord = z.object({ id: z.string(), network: z.literal('devnet'), company: z.string(), email: z.string().optional(), party: z.string(), wallet: z.string(), amount: z.string(), purpose: z.string(), status: z.string(), note: z.string(), trackingId: z.string().nullable(), sender: z.string().nullable().optional(), expiresAt: z.string().nullable(), error: z.string().nullable(), evidence: z.object({ transaction_id: z.string().optional(), source: z.string(), failure_kind: z.string().optional() }).passthrough().nullable(), events: z.array(z.object({ at: z.string(), kind: z.string() })) });
export type FundingRecord = z.infer<typeof fundingRecord>;
class FundingHttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function fundingApi(route: string, body?: unknown) {
  const response = await fetch('/api/' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new FundingHttpError(response.status, result.error?.message ?? 'Unable to reach ClearRoute. Retry with your saved request.');
  return result;
}
const titles: Record<string, string> = { pending: 'Waiting for review', approved: 'Approved — ready to send', submitting: 'Submitting to the wallet', uncertain: 'Transfer needs reconciliation', created: 'Accept the offer in your wallet', accepted: 'Accepted — delivery in progress', completed: 'CC delivered', failed: 'Transfer failed', rejected: 'Request declined' };
export function FundingReceipt({ record }: { record: FundingRecord }) {
  return <section className="ops-card funding-receipt"><span className="ops-kicker">YOUR DEVNET REQUEST</span><h2>{titles[record.status] ?? record.status}</h2><strong className="funding-amount">{record.amount} <small>CC</small></strong>
    <dl><div><dt>Team</dt><dd>{record.company}</dd></div><div><dt>Recipient party</dt><dd><code>{record.party}</code></dd></div><div><dt>Request reference</dt><dd><code>{record.id}</code></dd></div></dl>
    {record.sender && <p><strong>Expected sender:</strong><code className="funding-code">{record.sender}</code></p>}{record.status === 'created' && <p className="ops-alert">Open your own wallet, find the incoming ClearRoute offer, verify the amount and sender, then accept it. Accepting on this website is not required.</p>}
    {record.status === 'accepted' && <p>Your wallet accepted the offer. Wait for the sender wallet to finish delivery.</p>}
    {record.status === 'uncertain' && <p>The operator is checking the original transfer. Do not submit another request.</p>}
    {record.note && <p><strong>Operator note:</strong> {record.note}</p>}
    {record.expiresAt && <p>Offer expires: {new Date(record.expiresAt).toLocaleString()}</p>}
    {record.evidence?.transaction_id && <div><strong>{record.status === 'completed' ? 'Transfer transaction' : 'Wallet transaction'}</strong><code className="funding-code">{record.evidence.transaction_id}</code><small>Source: {record.evidence.source}</small></div>}
    {record.evidence?.failure_kind && <p>Reason: {record.evidence.failure_kind}</p>}
    <ol className="funding-timeline">{record.events.map((event, i) => <li key={i}><strong>{titles[event.kind] ?? event.kind}</strong><time>{new Date(event.at).toLocaleString()}</time></li>)}</ol>
  </section>;
}
const freshKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function storedDraft() { try { return JSON.parse(sessionStorage.getItem('clearroute.publicDraft') ?? 'null'); } catch { return null; } }
export default function PublicFunding() {
  const [key, setKey] = useState(() => /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '');
  const [record, setRecord] = useState<FundingRecord | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [info, setInfo] = useState<{ maxRequestCc: string; transfersEnabled: boolean } | null>(null);
  const draft = useRef(storedDraft()), locked = useRef(false);
  useEffect(() => { void fundingApi('public-funding').then(value => setInfo(z.object({ maxRequestCc: z.string(), transfersEnabled: z.boolean() }).parse(value))).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!key) return; let alive = true;
    const refresh = async () => { try { const r = fundingRecord.parse(await fundingApi('public-funding/track', { key })); if (alive) { setRecord(r); setError(''); } } catch(e) { if (alive) setError(e instanceof Error ? e.message : 'Could not load request.'); } };
    void refresh(); const timer = setInterval(() => void refresh(), 15000); return () => { alive = false; clearInterval(timer); };
  }, [key]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (locked.current) return; locked.current = true; setBusy(true); setError('');
    try {
      if (!draft.current) {
        const f = new FormData(e.currentTarget);
        draft.current = { key: freshKey(), network: 'devnet', company: String(f.get('company')), email: String(f.get('email')), party: String(f.get('party')), wallet: String(f.get('wallet')), amount: String(f.get('amount')), purpose: String(f.get('purpose')), consent: f.get('consent') === 'on', acceptsOffers: f.get('acceptsOffers') === 'on', website: String(f.get('website') ?? '') };
        sessionStorage.setItem('clearroute.publicDraft', JSON.stringify(draft.current));
      }
      const r = fundingRecord.parse(await fundingApi('public-funding/requests', draft.current));
      const secret = draft.current.key; setRecord(r); history.replaceState(null, '', '/funding#' + secret); setKey(secret);
      sessionStorage.removeItem('clearroute.publicDraft'); draft.current = null;
    } catch(e) {
      if (e instanceof FundingHttpError && e.status === 400) { draft.current = null; sessionStorage.removeItem('clearroute.publicDraft'); }
      setError(e instanceof Error ? e.message : 'Submission could not be confirmed. Retry the saved request.');
    }
    finally { locked.current = false; setBusy(false); }
  }
  return <div className="funding-public"><header className="funding-header"><a href="/" aria-label="Open ClearRoute workspace"><BrandLogo /></a><span className="ops-tag">DEVNET PILOT</span><nav><a href="/">Open workspace</a><a href="/funding">Request CC</a></nav></header>
    <main className="funding-layout"><section className="funding-intro"><span className="ops-kicker">MAKE ROOM FOR YOUR NEXT MOVE</span><h1>Build your idea.<br /><em>We’ll help fund<br />the next step.</em></h1><p>Request Canton Coin for your team’s Devnet wallet. One request, a human review, and a clear record of delivery.</p><div className="funding-art"><DnaArt /></div><ol><li>Tell us about your team and wallet.</li><li>We review your request and recipient.</li><li>Accept the offer in your wallet and track delivery here.</li></ol><p className="funding-disclosure">Devnet test CC only. No payment or invoice is created by this pilot. CC transfers fund your wallet; validator traffic funding is a separate service.</p></section>
    <div className="funding-content">{error && <div role="alert" className="ops-alert error">{error}</div>}
      {key ? <>{record ? <FundingReceipt record={record} /> : <p role="status">Loading your private request…</p>}<section className="ops-card"><h3>Keep your tracking link</h3><p>Bookmark this page. Anyone with this private link can view your request status. No wallet keys are needed.</p><label className="ops-field">Private tracking link<input readOnly value={location.origin + '/funding#' + key} onFocus={e => e.currentTarget.select()} /></label><p>Status refreshes every 15 seconds.</p></section></> : <section className="ops-card"><span className="ops-kicker">YOUR TEAM’S NEXT STEP</span><h2>Request Devnet CC</h2><p>Up to {info?.maxRequestCc ?? '10'} CC per party during this pilot. Requests are reviewed, never automatically paid.</p>{info && !info.transfersEnabled && <p className="ops-alert">Requests are open. Transfers are awaiting operator activation.</p>}
      <form className="ops-form-grid" onSubmit={e => void submit(e)}>
        <label className="ops-field">Team / project<input name="company" required minLength={2} maxLength={100} defaultValue={draft.current?.company} /></label>
        <label className="ops-field">Contact email<input name="email" type="email" required maxLength={200} defaultValue={draft.current?.email} /></label>
        <label className="ops-field ops-span">Full Canton Devnet Party ID<textarea name="party" required maxLength={300} placeholder="your-party::1220…" defaultValue={draft.current?.party} /></label>
        <label className="ops-field">Wallet provider<input name="wallet" required minLength={2} maxLength={100} placeholder="e.g. NODERS / Splice wallet" defaultValue={draft.current?.wallet} /></label>
        <label className="ops-field">Amount · CC<input name="amount" inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,10})?" defaultValue={draft.current?.amount ?? '1'} /></label>
        <label className="ops-field ops-span">What are you testing?<textarea name="purpose" required minLength={5} maxLength={500} defaultValue={draft.current?.purpose} /></label>
        <label className="funding-honeypot" aria-hidden="true">Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
        <label className="funding-check ops-span"><input type="checkbox" name="acceptsOffers" required defaultChecked={draft.current?.acceptsOffers} />My wallet is on Devnet and can receive and accept Splice wallet transfer offers.</label>
        <label className="funding-check ops-span"><input type="checkbox" name="consent" required defaultChecked={draft.current?.consent} />I control this recipient party and agree to share these details with ClearRoute for this test.</label>
        <button className="ops-button ops-span" disabled={busy || !info}>{busy ? 'Submitting…' : draft.current ? 'Retry saved request' : 'Request CC'}</button>
        {draft.current && <p className="ops-span">A request is saved in this tab. Retry preserves its original details to prevent duplicates. <button type="button" onClick={() => { setKey(draft.current.key); history.replaceState(null, '', '/funding#' + draft.current.key); }}>Check saved request</button></p>}
      </form><p className="ops-footnote">No password, recovery phrase, private key, or wallet access token is requested. Contact details are visible only to the operator; email ownership is not verified.</p></section>}
    </div></main><footer className="funding-footer">ClearRoute / CC for your next move. Devnet pilot.</footer></div>;
}
