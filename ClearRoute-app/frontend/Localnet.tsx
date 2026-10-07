import { useAccountStorage } from './account-storage';
import { apiFetch } from './http';
import { useEffect, useState } from 'react';
import { Activity, ArrowRight, RefreshCw } from 'lucide-react';
import type { Session } from './types';

type Run={id:string;tenant:string;status:string;createdAt:string;error?:string;steps:{name:string;updateId:string;recordTime:string;contractId:string}[]};
type NetworkState={connected:boolean;detail:string;checkedAt:string;identities:Record<string,string>;runs:Run[];metering:string};
export default function Localnet({session,tenantId}:{session:Session;tenantId:string}) {
  const storage = useAccountStorage();
  const [state,setState]=useState<NetworkState|null>(null);
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
  const requestKey=`clearroute.localnet.pending.${session}.${tenantId}`;
  const [pending,setPending]=useState(storage.getItem(requestKey));
  async function refresh(signal?:AbortSignal) {
    const response=await apiFetch('/api/localnet',{headers:{'x-demo-session':session},signal});
    const data=await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not reach the LocalNet connector.');
    setState(data);
  }
  useEffect(()=>{
    const controller=new AbortController();
    void refresh(controller.signal).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[session]);
  async function run() {
    const key=pending || crypto.randomUUID();
    storage.setItem(requestKey,key);setPending(key);setBusy(true);setError('');
    try {
      const response=await apiFetch('/api/localnet/runs',{method:'POST',headers:{'Content-Type':'application/json','x-demo-session':session,'idempotency-key':key},body:JSON.stringify({tenantId})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error?.message || 'Ledger operation could not be verified.');
      storage.removeItem(requestKey);setPending(null);
      await refresh();
    } catch(e) { setError(e instanceof Error?e.message:'Network response unavailable. Check the same request before starting another.'); }
    finally { setBusy(false); }
  }
  const blocked=state?.runs.some(r=>r.tenant===tenantId && r.status!=='completed');
  return <div className="localnet-workspace">
    <section className="card localnet-intro"><div className="card-heading"><div><span className="eyebrow">REAL LOCAL LEDGER · TEST NETWORK</span><h2>From service offer to confirmed completion</h2></div><span className={`badge ${state?.connected?'good':'neutral'}`}><span/>{state?.connected?'Connected':'Not connected'}</span></div>
      <p>Run the Daml workflow for {tenantId === 'atlas'?'Atlas Labs':'Nova Markets'} on your local Canton network. Each party uses its own scoped ledger user.</p>
      <p className="muted">This writes test contracts. It does not buy traffic, transfer CC, measure bytes, or create an invoice.</p>
      <div className="inline-actions"><button className="button" disabled={busy || !state?.connected || (!!blocked && !pending)} onClick={()=>void run()}><Activity size={16}/>{busy?'Waiting for ledger…':pending?'Check saved request':'Run ledger workflow'}<ArrowRight size={16}/></button><button className="button secondary" disabled={busy} onClick={()=>{setError('');void refresh().catch(e=>setError(e.message));}}><RefreshCw size={16}/>Refresh connection</button></div>
      {state && <p className="localnet-check">{state.detail} Checked {new Date(state.checkedAt).toLocaleTimeString()}.</p>}
      {error && <p role="alert" className="localnet-error">{error}</p>}
    </section>
    <section className="card localnet-identities"><div className="card-heading"><h2>LocalNet parties</h2></div>{Object.entries(state?.identities || {}).map(([name,party])=><div key={name}><strong>{name}</strong><code>{party}</code></div>)}</section>
    <section className="card"><div className="card-heading"><div><span className="eyebrow">RETURNED BY CANTON</span><h2>Ledger evidence</h2></div></div>{!state?.runs.length?<div className="empty"><Activity size={24}/><h3>No ledger workflows yet</h3><p>Run the sample to see actual transaction references here.</p></div>:state.runs.map(run=><article className="localnet-run" key={run.id}><div><strong>{run.tenant} · {run.status.replaceAll('_',' ')}</strong><time>{new Date(run.createdAt).toLocaleString()}</time></div><code>{run.id}</code>{run.steps.map(step=><div className="localnet-step" key={step.updateId}><strong>{step.name}</strong><span>Update ID</span><code>{step.updateId}</code><span>Contract ID</span><code>{step.contractId}</code><small>{step.recordTime}</small></div>)}{run.error && <p className="localnet-error">{run.error}</p>}{run.status==='needs_reconciliation' && <p>Some steps may already be on the ledger. Further submissions for this account are blocked until the saved request is reconciled.</p>}</article>)}</section>
    <div className="info-note"><Activity size={17}/><p>{state?.metering || 'Traffic metering is not connected.'} Existing usage, prices, invoices, and payment records remain fixtures in the other workspaces.</p></div>
  </div>;
}
