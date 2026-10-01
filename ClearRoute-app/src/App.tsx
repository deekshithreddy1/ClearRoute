import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, Clock3, Copy, Download, ExternalLink,
  FileText, Flame, Gauge, Layers3, LayoutDashboard, LoaderCircle, Menu,
  Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Wallet, X, Zap, AlertCircle,
} from 'lucide-react';
import type { AppState, Invoice, Page, PendingMutation, Session, Tenant } from './types';
import Localnet from './Localnet';
import Traffic from './Traffic';
import Metering from './Metering';
import Billing from './Billing';
import GasStation from './GasStation';

const nav: { name: Page; icon: typeof Gauge }[] = [
  { name: 'Gas station', icon: Zap },
  { name: 'LocalNet', icon: Activity },
  { name: 'Traffic purchases', icon: Gauge },
  { name: 'Measured usage', icon: Activity },
  { name: 'Billing', icon: FileText },
  { name: 'Overview', icon: LayoutDashboard }, { name: 'Managed usage', icon: Gauge },
  { name: 'CC Top-up', icon: Wallet }, { name: 'Activity', icon: Activity },
  { name: 'Invoices', icon: FileText }, { name: 'Settings', icon: Settings2 },
];
const currency = (value: string | number | undefined) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(Number(value || 0));
const number = (value: string | number | undefined, digits = 4) => new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Number(value || 0));
const bytes = (value: number = 0) => value >= 1_000_000 ? `${number(value / 1_000_000, 2)} MB` : value >= 1000 ? `${number(value / 1000, 2)} KB` : `${number(value, 0)} B`;
const date = (value: string | undefined, time = false) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(value)) : '—';
const short = (value = '') => value.length > 24 ? `${value.slice(0, 13)}…${value.slice(-6)}` : value;
const human = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const initialSession = (): Session => {
  const value = localStorage.getItem('launchfuel.session');
  return value === 'operator' || value === 'nova' ? value : 'atlas';
};
const initialPending = (): PendingMutation | null => {
  try { return JSON.parse(localStorage.getItem('launchfuel.pending') || 'null'); } catch { return null; }
};

function Badge({ status, children }: { status: string; children?: ReactNode }) {
  const good = /^(active|approved|paid|completed|confirmed|ready|available|connected|fulfilled)$/i.test(status);
  const bad = /failed|rejected|overdue|blocked|unavailable|not.connected/i.test(status);
  return <span className={`badge ${good ? 'good' : bad ? 'bad' : 'neutral'}`}><span />{children || human(status)}</span>;
}
function Empty({ icon: Icon = Layers3, title, detail, action }: { icon?: typeof Gauge; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={24} /></div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function Button({ children, onClick, disabled, secondary, small, type = 'button' }: { children: ReactNode; onClick?: () => void; disabled?: boolean; secondary?: boolean; small?: boolean; type?: 'button' | 'submit' }) {
  return <button type={type} className={`button ${secondary ? 'secondary' : ''} ${small ? 'small' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function CardHeading({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <div className="card-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{action}</div>;
}
function Stat({ label, value, detail, icon: Icon, accent }: { label: string; value: string; detail: string; icon: typeof Gauge; accent?: boolean }) {
  return <section className={`stat ${accent ? 'accent' : ''}`}><div className="stat-top"><span>{label}</span><Icon size={18} /></div><strong>{value}</strong><p>{detail}</p></section>;
}
function Modal({ title, detail, children, close, busy }: { title: string; detail: string; children: ReactNode; close: () => void; busy: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>('input,select,button');
    first?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close();
      if (event.key === 'Tab') {
        const all = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,[tabindex="0"]') || []);
        if (!all.length) return;
        const firstItem = all[0]; const lastItem = all[all.length - 1];
        if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus(); }
        if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [busy, close]);
  return <div className="modal-shade" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialogRef}>
    <button className="icon-button close" onClick={close} disabled={busy} aria-label="Close dialog"><X size={20} /></button>
    <span className="eyebrow">LOCAL DEMO</span><h2 id="modal-title">{title}</h2><p className="modal-intro">{detail}</p>{children}
  </div></div>;
}

export default function App() {
  const [session, setSession] = useState<Session>(initialSession);
  const [page, setPage] = useState<Page>('Overview');
  const [state, setState] = useState<AppState | null>(null);
  const [selectedTenant, setSelectedTenant] = useState('atlas');
  const [fetchError, setFetchError] = useState('');
  const [actionError, setActionError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [retry, setRetry] = useState<PendingMutation | null>(initialPending);
  const [mobileNav, setMobileNav] = useState(false);
  const [modal, setModal] = useState<'request' | 'usage' | 'fund' | 'payment' | null>(null);
  const [paymentInvoice, setPaymentInvoice] = useState<Invoice | null>(null);
  const [expandedInvoice, setExpandedInvoice] = useState<string | null>(null);
  const [topupCc, setTopupCc] = useState('10');
  const [topupConsent, setTopupConsent] = useState(false);
  const [activityFilter, setActivityFilter] = useState('all');
  const [copied, setCopied] = useState(false);
  const currentSession = useRef(session);
  currentSession.current = session;
  const isOperator = session === 'operator';
  const tenantId = isOperator ? selectedTenant : session;
  const tenant = state?.tenants.find(item => item.id === tenantId) || state?.tenants[0];
  const activeId = tenant?.id || tenantId;
  const usage = state?.usage.filter(item => item.tenantId === activeId) || [];
  const topups = state?.topups.filter(item => item.tenantId === activeId) || [];
  const invoices = state?.invoices.filter(item => item.tenantId === activeId) || [];
  const requests = state?.requests?.filter(item => item.tenantId === activeId) || [];
  const disabled = !!busy || !!retry;

  const loadState = useCallback(async (chosen: Session = session) => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/state', { headers: { 'x-demo-session': chosen } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || 'The demo service could not be reached.');
      if (currentSession.current === chosen) { setState(data); setFetchError(''); }
      return data as AppState;
    } catch (error) {
      if (currentSession.current === chosen) setFetchError(error instanceof Error ? error.message : 'Could not load the demo.');
      throw error;
    } finally { if (currentSession.current === chosen) setRefreshing(false); }
  }, [session]);

  useEffect(() => {
    setState(null); setActionError(''); setToast('');
    void loadState(session).catch(() => {});
    const timer = window.setInterval(() => { void loadState(session).catch(() => {}); }, 20000);
    return () => window.clearInterval(timer);
  }, [session, loadState]);
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); } }, [toast]);

  function switchSession(value: Session) {
    if (busy) return;
    setSession(value); localStorage.setItem('launchfuel.session', value); setModal(null);
    setMobileNav(false); setTopupConsent(false);
  }
  function navigate(value: Page) { setPage(value); setMobileNav(false); setActionError(''); }
  function persistRetry(value: PendingMutation | null) {
    setRetry(value);
    if (value) localStorage.setItem('launchfuel.pending', JSON.stringify(value));
    else localStorage.removeItem('launchfuel.pending');
  }
  async function perform(operation: PendingMutation) {
    setBusy(operation.label); setActionError('');
    try {
      const response = await fetch(operation.path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-session': operation.session, 'idempotency-key': operation.key }, body: JSON.stringify(operation.body),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status < 500) persistRetry(null);
        setActionError(data.error?.message || `The action was rejected (${response.status}).`);
        return;
      }
      await loadState(operation.session);
      persistRetry(null); setModal(null); setTopupConsent(false);
      setToast(`${operation.label} — recorded in the local demo.`);
    } catch (error) {
      persistRetry(operation);
      setActionError('The response could not be verified. Retry the same operation safely; the request identifier is preserved.');
    } finally { setBusy(''); }
  }
  function mutate(path: string, body: Record<string, unknown>, label: string) {
    if (disabled) return;
    const operation: PendingMutation = { path, body, label, session, key: crypto.randomUUID() };
    persistRetry(operation); void perform(operation);
  }
  const closeModal = useCallback(() => setModal(null), []);
  const openRequest = () => { setActionError(''); setModal('request'); };
  const openUsage = () => { setActionError(''); setModal('usage'); };
  const quoteExpired = state ? new Date(state.now).getTime() >= new Date(state.quote.expiresAt).getTime() : true;
  const pendingRequest = requests.find(item => /pending|requested/i.test(item.status));
  const isActive = tenant?.status === 'active';
  const outstanding = Number(tenant?.outstandingUsd || 0);
  const unbilled = Number(tenant?.unbilledUsd || 0);
  const limit = Number(tenant?.limitUsd || 0);
  const available = Math.max(0, limit - outstanding - unbilled);
  const pct = limit > 0 ? Math.min(100, ((outstanding + unbilled) / limit) * 100) : 0;
  const events = state?.events.filter(event => (!event.tenantId || event.tenantId === activeId) && (activityFilter === 'all' || event.type.toLowerCase().includes(activityFilter))) || [];

  function downloadInvoice(invoice: Invoice) {
    const csv = ['LOCAL DEMO ONLY - Not a payable invoice', `Invoice,${invoice.id}`, `Customer,${tenant?.name || ''}`, `Period,${invoice.periodStart} to ${invoice.periodEnd}`, '', 'Description,Amount USD,Reference',
      ...invoice.lines.map(line => [line.description, line.amountUsd, line.reference].map(field => `"${(/^[\s]*[=+@-]/.test(String(field)) ? "\'" : "") + String(field).replaceAll('"', '""')}"`).join(',')), '', `Total USD,${invoice.totalUsd}`, `Paid USD,${invoice.paidUsd}`].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `${invoice.id}-demo.csv`; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'open' : ''}`}>
      <a href="#" className="brand" onClick={event => { event.preventDefault(); navigate('Overview'); }}><img className="brand-wordmark" src="/branding/clearroute-wordmark.png" alt="ClearRoute" /></a>
      <div className="workspace"><span className="workspace-avatar">{isOperator ? <Layers3 size={18} /> : tenant?.name.slice(0, 1) || 'A'}</span><div><strong>{isOperator ? 'ClearRoute operations' : tenant?.name || 'Your workspace'}</strong><span>{isOperator ? 'Operator workspace' : 'Application workspace'}</span></div></div>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label="Main navigation">{nav.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${page === name ? 'active' : ''}`} aria-current={page === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon size={19} /><span>{name}</span>{name === 'Invoices' && invoices.filter(item => item.status !== 'paid').length > 0 && <span className="nav-count">{invoices.filter(item => item.status !== 'paid').length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="help-card"><div className="help-icon"><Sparkles size={18} /></div><strong>Built for your next step.</strong><p>Keep your team building. Put network funding on a clear path.</p><button onClick={() => navigate('Settings')}>Explore this demo <ArrowRight size={14} /></button></div>
      <div className="network-status"><span className="status-dot" />Local demo environment<ShieldCheck size={15} /></div><div className="sidebar-foot">CANTON NETWORK · PROTOTYPE</div></div>
    </aside>

    <div className="main-shell">
      <div className="demo-strip"><span className="demo-tag">DEMO</span><span>LocalNet ledger workspace + fixture billing. <strong>No real funds move.</strong></span><button onClick={() => navigate('Settings')}>View limitations <ArrowUpRight size={13} /></button></div>
      <header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={14} /><strong>{page}</strong></div>
      <div className="topbar-tools"><button className={`icon-button refresh ${refreshing ? 'spinning' : ''}`} title="Refresh demo state" aria-label="Refresh demo state" disabled={refreshing || !!busy} onClick={() => { void loadState().catch(() => {}); }}><RefreshCw size={17} /></button><div className="role-control"><label htmlFor="role">Local demo role</label><div className="select-wrap"><select id="role" value={session} disabled={!!busy} onChange={event => switchSession(event.target.value as Session)}><option value="atlas">Atlas · customer</option><option value="nova">Nova · customer</option><option value="operator">ClearRoute · operator</option></select><ChevronDown size={14} /></div></div><span className="user-avatar">{isOperator ? 'CR' : session === 'atlas' ? 'AT' : 'NV'}</span></div></header>

      <main id="main-content" tabIndex={-1}>
        {fetchError && <div className="alert error" role="alert"><AlertCircle size={19} /><div><strong>Connection needs attention</strong><p>{fetchError} {state ? 'Showing the last received state.' : 'Start the local demo service and retry.'}</p></div><button onClick={() => { void loadState().catch(() => {}); }}>Retry</button></div>}
        {retry && <div className="alert warning" role="status"><Clock3 size={19} /><div><strong>Unverified operation: {retry.label}</strong><p>Retry with its original identifier to avoid a duplicate. {retry.session !== session ? `Switch to the ${retry.session} role first.` : 'This also works after a page reload.'}</p></div><button disabled={!!busy || retry.session !== session} onClick={() => void perform(retry)}>Retry safely</button></div>}
        {actionError && <div className="alert error" role="alert"><AlertCircle size={19} /><div><strong>Action not completed</strong><p>{actionError}</p></div><button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={16} /></button></div>}
        {!state ? <div className="loading-state"><LoaderCircle className="spin" size={27} /><h2>Connecting to your workspace</h2><p>Loading the local demo account and activity.</p></div> : <>
          <div className="page-heading"><div><div className="eyebrow">{isOperator ? 'OPERATOR CONSOLE' : 'YOUR CANTON OPERATIONS'}</div><h1>{page === 'Overview' ? 'A clear path to your next transaction.' : page}</h1><p>{({ 'Gas station': 'Approve sponsorship, fund validator capacity, and execute application workflows.', Overview: 'Your funding, usage, and billing. All moving together.', 'Managed usage': 'Request an account, track consumption, and stay within your budget.', 'CC Top-up': 'A separate option when your app needs CC in its wallet.', Activity: 'Follow each funding request, usage event, and account update.', Invoices: 'Clear usage records. One bill every 15 days.', Settings: 'Your workspace, demo policies, and connection readiness.', LocalNet: 'Real Canton contracts and transaction evidence on your local network.', 'Traffic purchases': 'Buy shared validator capacity with LocalNet test CC.', 'Measured usage': 'Verified customer traffic and non-payable test invoice previews.', Billing: 'Finalize measured invoices and reconcile sandbox payments.' })[page]}</p></div>
          {isOperator && !['Gas station','Billing','Measured usage','Traffic purchases'].includes(page) && <label className="account-select">Viewing account<select value={activeId} disabled={!!busy} onChange={event => { setSelectedTenant(event.target.value); setTopupConsent(false); setExpandedInvoice(null); }}>{state.tenants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
          {!isOperator && page === 'Overview' && <Button onClick={isActive ? openUsage : openRequest} disabled={disabled || (!!pendingRequest && !isActive)}>{isActive ? <><Zap size={16} /> Simulate usage</> : pendingRequest ? <><Clock3 size={16} /> Request pending</> : <><Plus size={17} /> Get started</>}</Button>}</div>

          {page === 'Gas station' && <GasStation key={session} session={session} />}
          {page === 'Managed usage' && <div className="info-note"><p>This page contains simulated usage only. For funded LocalNet execution, <button className="button secondary" onClick={() => navigate('Gas station')}>Open gas station</button>.</p></div>}
          {page === 'Traffic purchases' && <Traffic key={session} session={session} />}
          {page === 'Measured usage' && <Metering key={session} session={session} />}
          {page === 'Billing' && <Billing key={session} session={session} />}
          {page === 'LocalNet' && <Localnet key={session + ':' + activeId} session={session} tenantId={activeId} />}
          {page === 'Overview' && <>
            <div className="overview-grid"><section className="hero-card"><div className="hero-content"><span className="hero-kicker"><span /> MANAGED TRAFFIC FUNDING</span><h2>Focus on your app.<br /><span>We handle the fuel.</span></h2><p>Use our CC reserve to fund Canton traffic, with a clear record of usage and periodic invoicing.</p><div className="hero-actions"><Button onClick={() => navigate('Managed usage')}>View managed usage <ArrowRight size={16} /></Button><span>15-day billing cycle</span></div></div><div className="fuel-visual" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit-dot dot-one" /><div className="orbit-dot dot-two" /><div className="fuel-tile"><Zap size={56} fill="currentColor" strokeWidth={1.2} /></div><div className="fuel-caption"><span />CANTON TRAFFIC</div></div></section>
            <section className="account-card"><div className="account-top"><span className="eyebrow">ACCOUNT STATUS</span><Badge status={tenant?.status || 'needs_setup'} /></div><h3>{tenant?.name}</h3><p>{isActive ? 'Your demo funding account is ready for supported usage.' : pendingRequest ? 'Your request is waiting for operator approval.' : 'Start with a funding request for your app.'}</p><div className="budget-line"><span>Available test credit</span><strong>{currency(available)}</strong></div><div className="progress-track"><span style={{ width: `${pct}%` }} /></div><div className="budget-foot"><span>{currency(outstanding + unbilled)} used or due</span><span>{currency(limit)} limit</span></div><button className="text-link" onClick={() => navigate('Managed usage')}>Manage account <ArrowUpRight size={15} /></button></section></div>
            <div className="stat-grid"><Stat label="Unbilled usage" value={currency(tenant?.unbilledUsd)} detail="Current demo billing cycle" icon={Layers3} /><Stat label="Outstanding invoices" value={currency(tenant?.outstandingUsd)} detail="Recorded USD amount still due" icon={FileText} /><Stat label="Metered app traffic" value={bytes(tenant?.usedBytes)} detail="Attributed demo usage" icon={Activity} /><Stat label="Recorded usage events" value={String(usage.length)} detail="Events for this application" icon={CheckCircle2} accent /></div>
            <div className="lower-grid"><section className="card"><CardHeading title="Recent activity" eyebrow="YOUR WORKSPACE" action={<button className="text-link" onClick={() => navigate('Activity')}>View all <ArrowRight size={15} /></button>} />{events.length ? <div className="event-list">{events.slice(0, 4).map(event => <div className="event" key={event.id}><span className="event-icon"><Activity size={16} /></span><div><strong>{event.message}</strong><span>{human(event.type)} · {date(event.at, true)}</span></div><Badge status="recorded">Demo</Badge></div>)}</div> : <Empty icon={Activity} title="Your activity starts here" detail="Funding requests and usage will appear as you work through the demo." />}</section>
            <section className="card getting-started"><CardHeading title="Take the guided route" eyebrow="TRY THE COMPLETE FLOW" /><div className="guide-step"><span className={requests.length ? 'done' : ''}>{requests.length ? <Check size={13} /> : '1'}</span><div><strong>Request managed funding</strong><p>Choose a test account limit.</p></div></div><div className="guide-step"><span className={isActive ? 'done' : ''}>{isActive ? <Check size={13} /> : '2'}</span><div><strong>Approve as the operator</strong><p>Use the local demo role switch above.</p></div></div><div className="guide-step"><span className={usage.length ? 'done' : ''}>{usage.length ? <Check size={13} /> : '3'}</span><div><strong>Record a usage event</strong><p>See its test rate and itemized charge.</p></div></div><div className="guide-step"><span className={invoices.length ? 'done' : ''}>{invoices.length ? <Check size={13} /> : '4'}</span><div><strong>Complete a billing cycle</strong><p>As operator, advance 15 days in Invoices.</p></div></div><button className="text-link" onClick={() => navigate(isActive ? 'Managed usage' : 'Managed usage')}>Continue the walkthrough <ArrowRight size={15} /></button></section></div>
          </>}

          {page === 'Managed usage' && <>
            <div className="stat-grid three"><Stat label="Available test credit" value={currency(available)} detail={`Within a ${currency(limit)} demo limit`} icon={Wallet} accent /><Stat label="Unbilled usage" value={currency(unbilled)} detail="Stored charges, not invoice-day repricing" icon={Layers3} /><Stat label="Attributed traffic" value={bytes(tenant?.usedBytes)} detail="Customer usage is separate from shared capacity" icon={Gauge} /></div>
            <section className="card"><CardHeading title="Your managed funding account" action={<Badge status={tenant?.status || 'needs_setup'} />} /><div className="managed-layout"><div><h3>{isActive ? 'Ready for your next usage event.' : pendingRequest ? 'A request is waiting for approval.' : 'Let’s put traffic funding in place.'}</h3><p className="muted readable">ClearRoute purchases network traffic from its own reserve. Your app’s recorded usage is tracked against its service allowance and billed separately.</p><div className="inline-actions"><Button onClick={openRequest} disabled={disabled || !!pendingRequest}><Plus size={16} />{pendingRequest ? 'Request pending' : isActive ? 'Request limit change' : 'Request funding'}</Button><Button secondary onClick={openUsage} disabled={disabled || !isActive}><Zap size={16} />Simulate app usage</Button></div></div><div className="account-details"><span>Application party</span><code title={tenant?.partyId}>{short(tenant?.partyId)}</code><span>Customer account</span><strong>{tenant?.name}</strong><span>Billing</span><strong>Usage invoiced every 15 days</strong></div></div>
            {requests.length > 0 && <div className="request-list">{requests.map(request => <div className="request-row" key={request.id}><div><strong>Managed funding request</strong><span>{currency(request.limitUsd)} limit · {date(request.createdAt, true)}</span></div><Badge status={request.status} />{isOperator && /pending|requested/i.test(request.status) && <Button small disabled={disabled} onClick={() => mutate(`/api/requests/${encodeURIComponent(request.id)}/approve`, { limitUsd: request.limitUsd }, 'Funding request approved')}><Check size={14} />Approve {currency(request.limitUsd)}</Button>}</div>)}</div>}</section>
            <section className="card"><CardHeading title="Metered usage" eyebrow="ITEMIZED RECORDS" action={<span className="subtle-label">{usage.length} events</span>} />{usage.length ? <div className="table-wrap"><table><thead><tr><th>Activity</th><th>Traffic</th><th>CC equivalent</th><th>Test USD / CC</th><th>Charge</th><th>Status</th></tr></thead><tbody>{usage.map(item => <tr key={item.id}><td><strong>{item.description}</strong><small>{date(item.createdAt, true)} · {short(item.reference)}</small></td><td>{bytes(item.trafficBytes)}</td><td>{number(item.ccEquivalent, 8)}</td><td>${number(item.rateUsd, 8)}</td><td className="strong">{currency(item.chargeUsd)}</td><td><Badge status={item.status} /></td></tr>)}</tbody></table></div> : <Empty icon={Gauge} title="No usage recorded yet" detail="After the operator approves your account, simulate a submission to see its metered traffic and charge." action={<Button secondary small disabled={!isActive || disabled} onClick={openUsage}>Simulate usage <ArrowRight size={14} /></Button>} />}</section><div className="info-note"><CircleHelp size={17} /><p>CC equivalent is a billing calculation. Traffic is purchased in batches; an individual usage event does not mean CC was burned for that transaction. All values here are simulated.</p></div>
          </>}

          {page === 'CC Top-up' && <>
            <div className="topup-grid"><section className="card topup-form"><CardHeading title="Send a small CC top-up" eyebrow="DIRECT TOKEN FUNDING" /><p className="muted">For apps that need CC in their own wallet. This is separate from managed traffic funding.</p><form onSubmit={event => { event.preventDefault(); mutate('/api/topups', { tenantId: activeId, ccAmount: topupCc, quoteId: state.quote.id }, 'Simulated CC top-up'); }}>
              <label className="field">Recipient application<div className="input-static"><span className="small-avatar">{tenant?.name[0]}</span><strong>{tenant?.name}</strong><Badge status="verified">Demo account</Badge></div></label>
              <label className="field">Party ID<input readOnly value={tenant?.partyId || ''} className="mono-input" /><span className="field-hint">Locked to this demo account. This is not a real recipient.</span></label>
              <label className="field">Amount<div className="input-unit"><input type="number" step="0.00000001" min="0.00000001" required value={topupCc} onChange={event => { setTopupCc(event.target.value); setTopupConsent(false); }} aria-label="CC top-up amount" /><span>CC</span></div></label>
              <div className="amount-presets">{['10', '25', '50', '100'].map(amount => <button key={amount} type="button" className={topupCc === amount ? 'selected' : ''} onClick={() => { setTopupCc(amount); setTopupConsent(false); }}>{amount} CC</button>)}</div>
              <div className="quote-box"><div><span>Fixture reference rate</span><strong>1 CC = ${number(state.quote.usdPerCc, 8)}</strong></div><div><span>Indicative token value</span><strong>{currency(Number(topupCc || 0) * Number(state.quote.usdPerCc))}</strong></div><p>The server validates the quote and returns the recorded charge. This preview is not a live market quote.</p><div className="quote-status"><Clock3 size={13} />{quoteExpired ? 'Quote expired — refresh before submitting.' : `Quote valid until ${date(state.quote.expiresAt, true)}`}</div></div>
              <div className="policy-note"><ShieldCheck size={17} /><span><strong>Demo policy:</strong> top-ups use test credit; real payment terms pending.</span></div>
              <label className="checkbox"><input type="checkbox" checked={topupConsent} onChange={event => setTopupConsent(event.target.checked)} /><span>I understand this is a simulated token transfer charged to this demo account.</span></label>
              <Button type="submit" disabled={disabled || !topupConsent || quoteExpired || Number(topupCc) <= 0}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowUpRight size={17} />}Simulate CC top-up</Button>
            </form></section><div className="topup-side"><section className="light-panel"><div className="panel-icon"><Wallet size={25} /></div><h2>The right kind of fuel.</h2><p>Choose the route that fits your app.</p><div className="comparison"><strong><Gauge size={18} />Managed traffic</strong><p>We purchase validator traffic. Your application receives a service allowance; no CC is sent to its wallet.</p></div><div className="comparison"><strong><Wallet size={18} />Direct CC top-up</strong><p>CC is sent to the app’s party. Holding CC does not automatically purchase validator traffic.</p></div></section><section className="card compact"><span className="eyebrow">PRICING TRANSPARENCY</span><h3>A price attached to every record.</h3><p className="muted">Each completed demo operation keeps its quote and timestamp. Previous charges are not recalculated when an invoice is created.</p><div className="source-pill"><span />{state.quote.source}</div></section></div></div>
            <section className="card"><CardHeading title="Top-up history" action={<span className="subtle-label">{topups.length} transfers</span>} />{topups.length ? <div className="table-wrap"><table><thead><tr><th>Created</th><th>Amount</th><th>Charge</th><th>Reference</th><th>Status</th></tr></thead><tbody>{topups.map(item => <tr key={item.id}><td>{date(item.createdAt, true)}</td><td className="strong">{number(item.ccAmount, 8)} CC</td><td>{currency(item.chargeUsd)}</td><td><code>{short(item.reference)}</code></td><td><Badge status={item.status} /></td></tr>)}</tbody></table></div> : <Empty icon={Wallet} title="No top-ups yet" detail="Your confirmed simulated CC transfers will appear here." />}</section>
          </>}

          {page === 'Activity' && <section className="card"><CardHeading title="Account timeline" action={<label className="filter-select"><span className="sr-only">Filter activity</span><select value={activityFilter} onChange={event => setActivityFilter(event.target.value)}><option value="all">All activity</option><option value="request">Requests</option><option value="usage">Usage</option><option value="topup">Top-ups</option><option value="invoice">Invoices</option><option value="payment">Payments</option></select></label>} />{events.length ? <div className="timeline">{events.map(event => <div className="timeline-row" key={event.id}><div className="timeline-marker"><Activity size={16} /></div><div className="timeline-content"><div><strong>{event.message}</strong><span>{date(event.at, true)}</span></div><p>{human(event.type)}</p><code>{event.id}</code></div></div>)}</div> : <Empty icon={Activity} title="No matching activity" detail="Try another filter, or make your first request to start the timeline." />}</section>}

          {page === 'Invoices' && <>
            <div className="info-note"><p>These are simulated billing records. <button className="button secondary" onClick={()=>navigate('Measured usage')}>View measured LocalNet invoice previews</button></p></div>
            <div className="stat-grid three"><Stat label="Current unbilled total" value={currency(unbilled)} detail="Finalized demo usage awaiting invoice" icon={Layers3} /><Stat label="Outstanding balance" value={currency(outstanding)} detail="Across unpaid demo invoices" icon={FileText} accent /><Stat label="Billing cycle" value="15 days" detail="USD amounts fixed when recorded" icon={Clock3} /></div>
            {isOperator && <section className="operator-bar"><div><span className="eyebrow">DEMO BILLING CONTROLS</span><h3>Move the clock. Close the cycle.</h3><p>Demo date: {date(state.now, true)}. Advancing time affects all demo accounts.</p></div><div className="inline-actions"><Button secondary disabled={disabled} onClick={() => mutate('/api/clock/advance', { days: 15 }, 'Demo clock advanced 15 days')}><Clock3 size={16} />Advance 15 days</Button><Button disabled={disabled || unbilled <= 0} onClick={() => mutate('/api/invoices/close', { tenantId: activeId }, 'Demo invoice created')}><FileText size={16} />Create invoice</Button></div></section>}
            <section className="card"><CardHeading title="Your invoices" eyebrow="CLEAR, ITEMIZED BILLING" action={<span className="subtle-label">{invoices.length} invoices</span>} />{invoices.length ? <div className="invoice-list">{invoices.map(invoice => <div className="invoice-item" key={invoice.id}><div className="invoice-row"><span className="invoice-icon"><FileText size={21} /></span><div className="invoice-name"><strong>{invoice.id}</strong><span>{date(invoice.periodStart)} – {date(invoice.periodEnd)} · Due {date(invoice.dueAt)}</span></div><strong className="invoice-total">{currency(invoice.totalUsd)}</strong><Badge status={invoice.status} /><button className="icon-button" title="Download demo invoice CSV" aria-label={`Download invoice ${invoice.id}`} onClick={() => downloadInvoice(invoice)}><Download size={18} /></button><button className="icon-button" aria-label={`Show details for ${invoice.id}`} aria-expanded={expandedInvoice === invoice.id} onClick={() => setExpandedInvoice(expandedInvoice === invoice.id ? null : invoice.id)}><ChevronDown size={18} className={expandedInvoice === invoice.id ? 'rotate' : ''} /></button></div>{expandedInvoice === invoice.id && <div className="invoice-details"><img className="invoice-wordmark" src="/branding/clearroute-wordmark.png" alt="ClearRoute" /><div className="table-wrap"><table><thead><tr><th>Description</th><th>Reference</th><th>Amount</th></tr></thead><tbody>{invoice.lines.map((line, index) => <tr key={`${line.reference}-${index}`}><td>{line.description}</td><td><code>{short(line.reference)}</code></td><td>{currency(line.amountUsd)}</td></tr>)}</tbody></table></div><div className="invoice-payment"><p>Paid: <strong>{currency(invoice.paidUsd)}</strong> · Remaining: <strong>{currency(Math.max(0, Number(invoice.totalUsd) - Number(invoice.paidUsd)))}</strong></p>{isOperator && Number(invoice.paidUsd) < Number(invoice.totalUsd) && <Button secondary small disabled={disabled} onClick={() => { setPaymentInvoice(invoice); setModal('payment'); }}>Record simulated payment <ArrowDownLeft size={15} /></Button>}</div><p className="invoice-disclaimer">LOCAL DEMO DOCUMENT · Not a payment demand. USD and USDC payment records are simulated.</p></div>}</div>)}</div> : <Empty icon={FileText} title="Your first invoice is ahead" detail={isOperator ? 'Record usage, advance the demo clock 15 days, then create an itemized invoice.' : 'Usage accumulates here until the operator closes a 15-day billing cycle.'} />}</section><div className="info-note"><CircleHelp size={17} /><p>A billing cycle is separate from a payment deadline. Review each invoice’s due date. Live payment collection and commercial payment terms are not enabled in this demo.</p></div>
          </>}

          {page === 'Settings' && <>
            <div className="settings-grid"><section className="card"><CardHeading title="Application profile" /><div className="profile-heading"><span className="profile-avatar">{tenant?.name[0]}</span><div><h3>{tenant?.name}</h3><Badge status={tenant?.status || 'needs_setup'} /></div></div><dl className="settings-list"><div><dt>Account ID</dt><dd>{tenant?.id}</dd></div><div><dt>Party ID</dt><dd className="party-copy"><code>{tenant?.partyId}</code><button className="icon-button" aria-label="Copy party ID" onClick={() => { void navigator.clipboard.writeText(tenant?.partyId || '').then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => setActionError('Clipboard access was not available. You can select and copy the party ID.')); }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button></dd></div><div><dt>Environment</dt><dd>{state.environment}</dd></div><div><dt>Demo date</dt><dd>{date(state.now, true)}</dd></div></dl></section><section className="card"><CardHeading title="What this demo does" /><div className="capability"><CheckCircle2 size={18} /><div><strong>Exercises the service workflow</strong><p>Requests, account approvals, usage, CC top-ups, invoices, and test payment records.</p></div></div><div className="capability"><ShieldCheck size={18} /><div><strong>Keeps the boundaries visible</strong><p>Local test balances and fixture prices. LocalNet submits real test contracts in its own workspace. No real CC or USD / USDC settlement.</p></div></div><div className="capability"><CircleHelp size={18} /><div><strong>Shows the production work ahead</strong><p>Native traffic purchases run in the Traffic purchases workspace. Measured usage provides verified LocalNet traffic and test invoice previews. Commercial pricing, production authentication, and payments remain unfinished.</p></div></div></section></div>
            {isOperator && state.treasury && <section className="card"><CardHeading title="Demo operating reserve" eyebrow="OPERATOR ONLY" action={<Button small secondary disabled={disabled} onClick={() => setModal('fund')}><Plus size={15} />Add fixture traffic</Button>} /><div className="treasury-grid"><div><span>Reserve balance</span><strong>{number(state.treasury.ccBalance, 8)} <small>CC</small></strong></div><div><span>Shared traffic capacity</span><strong>{bytes(state.treasury.trafficBytes)}</strong></div><div><span>CC spent in demo</span><strong>{number(state.treasury.spentCc, 8)} <small>CC</small></strong></div></div><p className="card-footnote">Shared validator capacity and customer billing allowances are distinct. This reserve is a local fixture, not your real exchange balance.</p></section>}
            <section className="card"><CardHeading title="Connection readiness" eyebrow="INTEGRATION STATUS" />{state.readiness.length ? <div className="readiness-list">{state.readiness.map((item, index) => <div key={`${item.name}-${index}`}><span className="readiness-icon"><Layers3 size={18} /></span><div><strong>{item.name}</strong><p>{item.detail}</p></div><Badge status={item.status} /></div>)}</div> : <Empty title="Readiness has not been reported" detail="No connection status was returned by the demo service." />}</section>
            <section className="documentation-card"><BookOpen size={24} /><div><h3>Built around Canton’s traffic model.</h3><p>Learn how traffic funding differs from a direct token transfer.</p></div><a className="text-link" href="https://docs.canton.network/global-synchronizer/deployment/synchronizer-traffic" target="_blank" rel="noreferrer">Canton documentation <ExternalLink size={15} /></a></section>
          </>}
          <footer className="page-footer"><span>ClearRoute <span className="footer-dot">/</span> Make room for what you’re building.</span><span>Local demo · No real funds</span></footer>
        </>}
      </main>
    </div>
    {toast && <div className="toast" role="status"><CheckCircle2 size={20} /><span>{toast}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
    {modal && state && <Modal title={modal === 'request' ? 'Request managed funding' : modal === 'usage' ? 'Simulate application usage' : modal === 'fund' ? 'Fund shared demo traffic' : 'Record a simulated payment'} detail={modal === 'request' ? 'Choose a test account limit. The demo operator will review your request.' : modal === 'usage' ? 'Record a simulated submission for this application. No Canton transaction will be sent.' : modal === 'fund' ? 'Spend from the simulated CC reserve to add shared traffic capacity.' : 'This creates a test payment record only. It does not collect USD or USDC.'} close={closeModal} busy={!!busy}>
      {actionError && <div className="modal-error" role="alert"><AlertCircle size={16} />{actionError}</div>}
      <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        if (modal === 'request') mutate('/api/requests', { tenantId: activeId, mode: 'managed', limitUsd: String(form.get('limit')) }, 'Managed funding requested');
        if (modal === 'usage') mutate('/api/usage', { tenantId: activeId, description: String(form.get('description')), trafficBytes: Number(form.get('bytes')) }, 'Simulated usage recorded');
        if (modal === 'fund') mutate('/api/treasury/fund', { trafficBytes: Number(form.get('bytes')) }, 'Shared demo traffic funded');
        if (modal === 'payment' && paymentInvoice) mutate(`/api/invoices/${encodeURIComponent(paymentInvoice.id)}/payments`, { amountUsd: String(form.get('amount')), rail: String(form.get('rail')), reference: String(form.get('reference')) }, 'Simulated payment recorded');
      }}>
        <div className="modal-account"><span className="small-avatar">{tenant?.name[0]}</span><div><strong>{tenant?.name}</strong><span>{short(tenant?.partyId)}</span></div></div>
        {modal === 'request' && <><label className="field">Requested test credit limit<div className="input-unit"><input name="limit" type="number" step="0.01" min="0.01" defaultValue="25.00" required /><span>USD</span></div></label><p className="field-hint">The operator approves this limit. It covers usage and unpaid balances under the demo policy.</p></>}
        {modal === 'usage' && <><label className="field">Activity description<input name="description" defaultValue="Sample application transaction" maxLength={160} required /></label><label className="field">Simulated traffic size<div className="input-unit"><input name="bytes" type="number" min="1" step="1" defaultValue="1000" required /><span>bytes</span></div></label><p className="field-hint">The server checks your account and funds shared traffic from the demo reserve when needed.</p></>}
        {modal === 'fund' && <><label className="field">Traffic to purchase<div className="input-unit"><input name="bytes" type="number" min="1" step="1" defaultValue="1000000" required /><span>bytes</span></div></label><p className="field-hint">This increases shared capacity. It does not increase a customer’s credit limit.</p></>}
        {modal === 'payment' && paymentInvoice && <><label className="field">Payment amount<div className="input-unit"><input name="amount" type="number" min="0.000001" step="0.000001" defaultValue={(Number(paymentInvoice.totalUsd) - Number(paymentInvoice.paidUsd)).toFixed(6)} required /><span>USD</span></div></label><label className="field">Simulated payment rail<select name="rail"><option value="USD">USD — simulated bank payment</option><option value="USDC">USDC — simulated settlement</option></select></label><label className="field">Test payment reference<input name="reference" placeholder="e.g. DEMO-PAYMENT-001" maxLength={120} required /></label><div className="policy-note"><AlertCircle size={17} /><span>A reference is not proof of a real payment. This action only demonstrates invoice reconciliation.</span></div></>}
        <div className="modal-actions"><Button secondary onClick={closeModal} disabled={!!busy}>Cancel</Button><Button type="submit" disabled={disabled}>{busy ? <LoaderCircle size={16} className="spin" /> : modal === 'request' ? <ArrowRight size={16} /> : <Check size={16} />}{busy ? 'Recording…' : modal === 'request' ? 'Submit request' : modal === 'usage' ? 'Record test usage' : modal === 'fund' ? 'Fund test traffic' : 'Record test payment'}</Button></div>
      </form>
    </Modal>}
  </div>;
}
