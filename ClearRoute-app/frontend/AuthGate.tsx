import { useEffect, useRef, useState, type FormEvent } from 'react';
import App from './App';
import OperationsApp from './OperationsApp';
import { z } from 'zod';
import { AccountContext } from './account-storage';

const principalSchema = z.discriminatedUnion('role', [
  z.object({ id: z.string().min(1), name: z.string(), role: z.literal('operator'), tenantId: z.null() }),
  z.object({ id: z.string().min(1), name: z.string(), role: z.literal('customer'), tenantId: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/) }),
]);
const statusSchema = z.object({ mode: z.enum(['required', 'demo']), networkMode: z.enum(['offline', 'localnet', 'devnet', 'testnet', 'mainnet']), principal: principalSchema.nullable() });
type Status = z.infer<typeof statusSchema>;

export default function AuthGate() {
  const generation = useRef(0);
  const changing = useRef(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (changing.current) return;
      const version = ++generation.current;
      try {
        const response = await fetch('/api/auth/session');
        if (!response.ok) throw new Error('Identity service is unavailable. Retry when the backend is ready.');
        const next = statusSchema.parse(await response.json());
        if (alive && version === generation.current) { setStatus(next); setError(''); }
      } catch (e) { if (alive && version === generation.current) { setStatus(null); setError(e instanceof Error ? e.message : 'Unable to check your session.'); } }
    };
    const expired = () => { ++generation.current; setStatus(old => old && { ...old, principal: null }); setError('Your session has ended. Sign in again.'); };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 60000);
    window.addEventListener('clearroute:unauthorized', expired);
    window.addEventListener('focus', refresh);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('clearroute:unauthorized', expired); window.removeEventListener('focus', refresh); };
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault(); changing.current = true; ++generation.current; setBusy(true); setError('');
    const submittedKey = accessKey; setAccessKey('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: submittedKey }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Sign-in failed.');
      const authenticated = principalSchema.parse(body.principal);
      setStatus(old => old && { ...old, principal: authenticated });
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign in.'); }
    finally { changing.current = false; setBusy(false); }
  }
  async function logout() {
    changing.current = true; ++generation.current;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Sign-out could not be confirmed. Retry.');
      setStatus(old => old && { ...old, principal: null });
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to sign out.'); }
    finally { changing.current = false; setBusy(false); }
  }
  const principal = status?.principal;
  if (status?.mode === 'demo' || principal) return <AccountContext.Provider value={principal?.id ?? null}>
    <div className="session-banner"><span>{status?.networkMode === 'offline' ? 'Offline · Canton connections disabled' : `${status?.networkMode} · Canton Network`}{status?.mode === 'demo' ? ' · Demo role switching enabled' : ` · ${principal?.name}`}</span>{principal && <button onClick={() => void logout()} disabled={busy}>Sign out</button>}{error && <span role="alert">{error}</span>}</div>
    {principal ? <OperationsApp key={principal.id} identity={principal} initialNetwork={status?.networkMode === 'testnet' || status?.networkMode === 'mainnet' ? status.networkMode : 'devnet'} /> : <App />}
  </AccountContext.Provider>;
  return <main className="auth-page"><form onSubmit={login} className="auth-card"><span className="eyebrow">CLEARROUTE</span><h1>Sign in</h1><p>Use the access key issued by your administrator. Your account determines which customer and actions you can access.</p>
    {!status && !error && <p role="status">Checking session…</p>}
    {error && <p role="alert">{error}</p>}
    {status && <><label htmlFor="access-key">Access key</label><input id="access-key" type="password" autoComplete="off" value={accessKey} onChange={event => setAccessKey(event.target.value)} required disabled={busy} /><button className="button" disabled={busy || !accessKey.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button><p>{status.networkMode === 'offline' ? 'Offline testing: no Canton connections or transactions.' : 'Canton Network · Access is scoped to your account.'}</p></>}
    {!status && error && <button type="button" className="button" onClick={() => window.location.reload()}>Retry connection</button>}
  </form></main>;
}
