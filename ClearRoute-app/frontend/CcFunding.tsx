import { useRef, useState } from 'react';
import { Wallet, ArrowUpRight, Clock3 } from 'lucide-react';
import type { OperationsState } from './operations-api';

type WalletSnapshot = { party: string; balanceCc: string; checkedAt: string };
type Props = { state: OperationsState; operator: boolean; busy: boolean; send: (route: string, body: unknown) => Promise<boolean>; wallet?: WalletSnapshot | null };
export function CcFunding({ state, operator, busy, send, wallet }: Props) {
  const key = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState('1');
  const requests = state.requests.filter(r => r.mode === 'DirectTopUp');
  const pending = state.requests.some(r => r.status === 'pending');
  return <div>
    <section className="ops-card cc-funding-hero"><div><span className="ops-kicker">DIRECT CANTON COIN FUNDING</span><h2>CC for your next transaction.</h2><p>Request coins for your startup’s treasury. Track the review and delivery from one place.</p></div><Wallet size={42} /></section>
    <div className={`ops-alert${operator && wallet ? '' : ' attention'}`} role="status"><Clock3 size={20}/><p><strong>{operator && wallet ? `Treasury wallet connected · ${wallet.balanceCc} CC available` : 'Treasury wallet connection pending'}</strong><br/>{operator && wallet ? 'The NODERS wallet balance is verified. Review each recipient before delivery.' : operator ? 'Requests and reviews are available. CC transfers will become available after the treasury wallet is connected and verified.' : 'Submit your party and validator details. The ClearRoute operator will verify the destination before delivery.'}</p></div>
    <div className="ops-two-column">
      <section className="ops-card"><span className="ops-kicker">{operator ? 'FUNDING DESK' : 'YOUR NEXT TOP-UP'}</span><h2>{operator ? 'Review before delivery' : 'Request Canton Coin'}</h2>
        {operator ? <><p>{requests.filter(r => r.status === 'pending').length} requests awaiting review</p><p>{requests.filter(r => r.status === 'approved').length} approved requests awaiting delivery</p><p>Treasury balance: {wallet ? `${wallet.balanceCc} CC` : 'Not available'}</p><button className="ops-button" disabled={!wallet}>Connect treasury to enable transfers</button></> :
        <form className="ops-form-grid" onSubmit={async e => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); const ok = await send('requests', { key: key.current, mode: 'DirectTopUp', amount, reason: String(f.get('reason')).trim() || 'CC funding for Canton application activity', recipient: { company: String(f.get('company')), email: String(f.get('email')), partyId: String(f.get('partyId')).trim(), validator: String(f.get('validator')), ownershipReference: String(f.get('ownershipReference')) } }); if (ok) { key.current = crypto.randomUUID(); form.reset(); setAmount('1'); } }}>
          <label className="ops-field">Company name<input name="company" required minLength={2} maxLength={100}/></label>
          <label className="ops-field">Contact email<input name="email" type="email" required maxLength={254}/></label>
          <label className="ops-field ops-span">Receiving treasury party ID<input name="partyId" required minLength={10} maxLength={300} defaultValue={state.accounts[0]?.party}/></label>
          <label className="ops-field ops-span">Validator provider / hosting details<input name="validator" required minLength={3} maxLength={300} placeholder="For example: NODERS Devnet"/></label>
          <label className="ops-field ops-span">Party ownership evidence reference<input name="ownershipReference" required minLength={3} maxLength={300} placeholder="Reference for the operator to verify; no passwords or keys"/></label>
          <label className="ops-field">Amount · CC<input aria-label="Requested CC" value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,10})?" required maxLength={30}/></label>
          <label className="ops-field">Network<input value={state.network} readOnly/></label>
          <label className="ops-field ops-span">Notes for the team (optional)<input name="reason" maxLength={300}/></label>
          <p className="ops-form-note ops-span">Your receiving party is subject to verification. Approval does not mean coins have arrived. Holding CC does not automatically buy validator traffic.</p>
          <button className="ops-button ops-span" disabled={busy || pending || !state.configured}><ArrowUpRight size={16}/>{pending ? 'Existing request awaiting review' : 'Request CC'}</button>
        </form>}
      </section>
      <section className="ops-card"><span className="ops-kicker">FROM REQUEST TO RECEIPT</span><h2>A clear path to funding</h2><ol className="cc-funding-steps"><li><strong>Register your destination</strong><p>Provide the treasury party and hosting information.</p></li><li><strong>Review the request</strong><p>The operator checks ownership, amount and funding terms.</p></li><li><strong>Deliver CC</strong><p>A connected treasury submits the approved transfer.</p></li><li><strong>Verify the receipt</strong><p>Confirmed delivery will include the native transaction reference.</p></li></ol></section>
    </div>
    <section className="ops-card"><h2>{operator ? 'CC funding queue' : 'Your CC requests'}</h2>{!requests.length && <p>No CC requests yet. Your first request will appear here.</p>}{requests.map(r => { const recipient = state.recipients.find(p => p.requestId === r.id); return <article className="ops-customer" key={r.id}><div className="ops-section-heading"><h3>{r.amount} CC · {recipient?.company ?? r.tenant}</h3><span className="ops-tag">{r.status === 'approved' ? 'Approved · awaiting wallet' : r.status === 'pending' ? 'Awaiting review' : 'Rejected'}</span></div><p>{r.reason}</p>{recipient && <details><summary>Receiving party and verification details</summary><p>{recipient.email}</p><code style={{ overflowWrap: 'anywhere' }}>{recipient.partyId}</code><p>{recipient.validator}</p><p>Ownership evidence: {recipient.ownershipReference}</p><p>Customer-provided details; verify before funding.</p></details>}<small>Requested {new Date(r.createdAt).toLocaleString()} · {state.network}</small>{r.decision && <details><summary>Review decision</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{r.decision}</pre></details>}{operator && r.status === 'pending' && <form className="ops-form-grid" onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); await send('requests/' + r.id, { status: String(f.get('status')), note: String(f.get('note')) }); }}><label className="ops-field">Decision<select name="status"><option value="approved">Approve request</option><option value="rejected">Reject request</option></select></label><label className="ops-field">Review note<input name="note" required minLength={3} maxLength={300}/></label><button className="ops-button" disabled={busy}>Save review</button></form>}</article>; })}</section>
  </div>;
}
