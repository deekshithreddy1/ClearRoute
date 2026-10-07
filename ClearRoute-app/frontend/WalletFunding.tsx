import { useEffect, useState } from 'react';
import { apiFetch } from './http';
import { useAccountStorage } from './account-storage';
import type { Session } from './types';

type Transfer = { id: string; tenant: string; amountCc: string; sender: string; receiver: string; status: string; consentAt: string | null; error: string | null; receipt: { transactionId: string; contractId: string } | null };
type State = { wallets: { tenant: string; party?: string; balanceCc?: string; treasury?: { party: string; balanceCc: string }; error: string | null }[]; transfers: Transfer[] };
type Pending = { key: string; tenantId: string; amountCc: string };
export default function WalletFunding({ session }: { session: Session }) {
  const storage = useAccountStorage();
  const [state,setState] = useState<State | null>(null), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [tenant,setTenant] = useState('atlas'), [amount,setAmount] = useState('1'), [network,setNetwork] = useState('LocalNet'), [partyId,setPartyId] = useState('');
  const [pending,setPending] = useState<Pending | null>(() => { try { return JSON.parse(storage.getItem('clearroute.native-funding') || 'null'); } catch { return null; } });
  async function refresh(signal?: AbortSignal) {
    const r = await apiFetch('/api/wallet-funding',{headers:{'x-demo-session':session},signal}); const body = await r.json();
    if (!r.ok) throw new Error(body.error?.message || 'Wallet funding unavailable'); setState(body);
  }
  useEffect(() => { const controller = new AbortController(); const update = () => void refresh(controller.signal).catch(e => { if (!controller.signal.aborted) setError(e.message); }); update(); const timer = setInterval(update,5000); return () => {clearInterval(timer);controller.abort();}; },[session]);
  async function action(route: string, body: unknown, key?: string) {
    setBusy(true); setError('');
    try {
      const r = await apiFetch(route,{method:'POST',headers:{'x-demo-session':session,'content-type':'application/json',...(key ? {'idempotency-key':key} : {})},body:JSON.stringify(body)});
      const result = await r.json(); if (!r.ok) {
        // Validation failures occur before the service persists a transfer intent.
        if (key && r.status === 400) {setPending(null);storage.removeItem('clearroute.native-funding');}
        throw new Error(result.error?.message || 'Result unknown. Retry the saved request.');
      }
      if (key) {setPending(null);storage.removeItem('clearroute.native-funding');} await refresh();
    } catch(e) {setError(e instanceof Error ? e.message : 'Result unknown.');} finally {setBusy(false);}
  }
  useEffect(() => { const party = state?.wallets.find(w => w.tenant === tenant)?.party; if (party && !partyId) setPartyId(party); }, [state,tenant,partyId]);
  function offer() { const saved = pending || {key:crypto.randomUUID(),tenantId:tenant,amountCc:amount}; storage.setItem('clearroute.native-funding',JSON.stringify(saved)); setPending(saved); void action('/api/wallet-funding',{tenantId:saved.tenantId,amountCc:saved.amountCc,recipientPartyId:partyId},saved.key); }
  const unresolved = state?.transfers.some(t => !['completed','failed'].includes(t.status));
  return <div className="localnet-workspace">
    <section className="card localnet-intro"><span className="eyebrow">NATIVE WALLET FUNDING · LOCALNET TEST CC</span><h2>Send CC to a customer wallet</h2><p>The operator creates an offer. The recipient signs in and accepts. Delivery is confirmed only after Canton transaction evidence matches the recipient and amount. Holding CC does not purchase validator traffic.</p>
      {error && <p role="alert" className="localnet-error">{error}</p>}
      {state?.wallets.map(w => <article className="localnet-run" key={w.tenant}><strong>{w.tenant} wallet</strong>{w.error ? <p role="alert">{w.error}</p> : <><p>{w.balanceCc} test CC available</p><code className="traffic-id">{w.party}</code>{w.treasury && <details><summary>ClearRoute treasury: {w.treasury.balanceCc} test CC</summary><p>To replenish this treasury, a supplier sends CC to this party and the treasury owner accepts it in the provider wallet. LocalNet coins have no monetary value.</p><code className="traffic-id">{w.treasury.party}</code></details>}</>}</article>)}
      {session === 'operator' && <form onSubmit={e => {e.preventDefault();offer();}}><label className="field">Network<select value={network} onChange={e=>setNetwork(e.target.value)} disabled={busy}><option>LocalNet</option><option disabled>DevNet (configure validator)</option><option disabled>TestNet (configure validator)</option><option disabled>MainNet (production review required)</option></select></label><label className="field">Application treasury<select value={pending?.tenantId || tenant} disabled={busy || !!pending} onChange={e=>{setTenant(e.target.value);setPartyId('')}}><option value="atlas">Atlas</option><option value="nova">Nova</option></select></label><label className="field">Treasury party ID<input value={partyId} disabled={busy || !!pending} onChange={e=>setPartyId(e.target.value)} placeholder="Enter the application party ID" required /></label><label className="field">Amount in test CC<input inputMode="decimal" value={pending?.amountCc || amount} disabled={busy || !!pending} onChange={e=>setAmount(e.target.value)} required /></label><p>LocalNet is the active network. The configured treasury party is created by <code>npm run wallet:setup</code>; the party ID is checked before any CC leaves the provider wallet. Limit: 100 CC per transfer; 1000 CC total.</p><button className="button" disabled={busy || network !== 'LocalNet' || !state || !partyId || (!pending && (!!unresolved || !/^\d+(\.\d{1,10})?$/.test(amount) || Number(amount)<=0 || Number(amount)>100))}>{busy?'Checking…':pending?'Retry saved transfer':'Transfer test CC'}</button>{pending && <p>The recipient, amount and request ID remain saved until the server acknowledges the operation. Correct a rejected request only after checking its status.</p>}</form>}
    </section>
    <section className="card"><h2>Native transfer history</h2>{!state?.transfers.length && <p>No native transfers recorded.</p>}{state?.transfers.map(t => <article className="localnet-run" key={t.id}><strong>{t.amountCc} test CC to {t.tenant} · {t.status.replaceAll('_',' ')}</strong><code>{t.id}</code><p>Recipient: <code>{t.receiver}</code></p>{t.error && <p role="alert">{t.error}</p>}{t.receipt ? <><p>Verified coin delivery</p><code>{t.receipt.transactionId}</code><code>{t.receipt.contractId}</code></> : <p>Delivery not yet verified.</p>}{!['completed','failed'].includes(t.status) && <div className="inline-actions">{session !== 'operator' && !t.consentAt && <button className="button" disabled={busy} onClick={()=>void action(`/api/wallet-funding/${encodeURIComponent(t.id)}/accept`,{})}>Accept {t.amountCc} test CC</button>}<button className="button secondary" disabled={busy} onClick={()=>void action(`/api/wallet-funding/${encodeURIComponent(t.id)}/reconcile`,{})}>Check transfer status</button></div>}</article>)}</section>
  </div>;
}
