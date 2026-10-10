import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { fundingApi, fundingRecord, FundingReceipt } from './PublicFunding';
import { CredentialStatus, credentialStatusSchema } from './CredentialStatus';

const stateSchema = z.object({ transfersEnabled: z.boolean(), maxRequestCc: z.string(), budgetCc: z.string(), reservedCc: z.string(), deliveredCc: z.string(), credentialStatus: credentialStatusSchema.optional(), wallet: z.object({ party: z.string(), balanceCc: z.string(), checkedAt: z.string() }).nullable(), requests: z.array(fundingRecord) });
export default function DemoTransfers() {
  const [data, setData] = useState<z.infer<typeof stateSchema> | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const load = useCallback(async () => { try { setData(stateSchema.parse(await fundingApi('devnet-funding'))); } catch(e) { setError(e instanceof Error ? e.message : 'Could not load funding queue.'); } }, []);
  useEffect(() => { void load(); const timer = setInterval(() => { if (!locked.current) void load(); }, 15000); return () => clearInterval(timer); }, [load]);
  async function act(route: string, body: unknown) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); setNotice('');
    try { const result = await fundingApi('devnet-funding/' + route, body); setNotice(result.status ? `Request status: ${result.status}.` : 'Treasury identity, Devnet connection, and balance checked.'); await load(); }
    catch(e) { setError(e instanceof Error ? e.message : 'Could not confirm action.'); await load(); }
    finally { locked.current = false; setBusy(false); }
  }
  function review(e: FormEvent<HTMLFormElement>, id: string) { e.preventDefault(); const f = new FormData(e.currentTarget); void act(id + '/review', { decision: f.get('decision'), note: f.get('note'), recipientVerified: f.get('verified') === 'on' }); }
  return <div className="funding-admin"><section className="ops-card"><span className="ops-kicker">PUBLIC DEVNET PILOT</span><h2>Requests to real wallet delivery</h2><p>Share the request page with a tester. Confirm their wallet supports Splice transfer offers before approving. They accept the offer in their own wallet.</p><label className="ops-field">Share this public link<input readOnly value={location.origin + '/funding'} onFocus={e => e.currentTarget.select()} /></label><a href="/funding" target="_blank" rel="noreferrer">Open tester page</a><div className="funding-admin-actions"><button className="ops-button" disabled={busy} onClick={() => void act('check', {})}>Check treasury wallet</button><button className="ops-button secondary" disabled={busy} onClick={() => { setError(''); void load(); }}>Refresh requests</button></div>
      {data && <><p><strong>{data.transfersEnabled ? 'Devnet sends enabled' : 'Sends disabled'}</strong> · Maximum {data.maxRequestCc} CC per request · {data.budgetCc} CC total delivery budget, excluding fees.</p><p>{data.deliveredCc} CC delivered · {data.reservedCc} CC committed including deliveries.</p>{data.wallet ? <details><summary>Observed balance: {data.wallet.balanceCc} CC</summary><code>{data.wallet.party}</code><p>Checked {new Date(data.wallet.checkedAt).toLocaleString()}. Fees and other spending can change the balance.</p></details> : <p>Check the treasury wallet before sending.</p>}</>}
      <p className="ops-footnote">Pilot transfers are separate from service agreements and USD invoicing. Delivery is confirmed by the NODERS wallet status API, with its transaction reference. This is not an independent ledger audit.</p></section>
    <CredentialStatus value={data?.credentialStatus} />
    {error && <p role="alert" className="ops-alert error">{error}</p>}{notice && <p role="status" className="ops-alert">{notice}</p>}
    {data?.requests.length === 0 && <section className="ops-card"><h3>Ready for your first tester</h3><p>Send the public link above. Their request will appear here automatically.</p></section>}
    {data?.requests.map(r => <article className="ops-card" key={r.id}><FundingReceipt record={r} /><p><strong>Contact:</strong> {r.email} (unverified) · <strong>Wallet:</strong> {r.wallet}</p><p><strong>Test purpose:</strong> {r.purpose}</p>{r.error && <p role="alert" className="ops-alert attention">{r.error}</p>}
      {r.status === 'pending' && <form className="ops-form-grid" onSubmit={e => review(e, r.id)}><label className="ops-field">Decision<select name="decision"><option value="approved">Approve</option><option value="rejected">Decline</option></select></label><label className="ops-field">Note to requester<input name="note" required minLength={5} maxLength={500} /></label><label className="funding-check ops-span"><input name="verified" type="checkbox" />I verified with the tester that they control this Devnet party and can accept Splice wallet offers.</label><button className="ops-button ops-span" disabled={busy}>Save review</button></form>}
      {r.status === 'approved' && <button className="ops-button" disabled={busy || !data.transfersEnabled} onClick={() => { if (window.confirm(`Send a ${r.amount} CC Devnet offer to\n${r.party}\n\nThe recipient must accept it in their wallet. Fees are additional.`)) void act(r.id + '/send', {}); }}>Send {r.amount} CC offer</button>}
      {['submitting', 'uncertain', 'created', 'accepted'].includes(r.status) && <button className="ops-button secondary" disabled={busy} onClick={() => void act(r.id + '/reconcile', {})}>Reconcile original transfer</button>}
    </article>)}
  </div>;
}
