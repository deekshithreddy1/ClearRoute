import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, Wallet } from 'lucide-react';

type Point = { value: number };
type Quote = { value: number | null; change: number | null; checkedAt: number | null; points: Point[]; source: string };

const PRICE_URL = '/api/public-price';

function parseQuote(payload: Record<string, { usd?: number; usd_24h_change?: number } | string>) {
  const item = payload['canton-coin'] || payload['canton-network'];
  return typeof item !== 'string' && item?.usd && Number.isFinite(item.usd) ? { value: item.usd, change: Number.isFinite(item.usd_24h_change) ? item.usd_24h_change! : null, source: typeof payload.source === 'string' ? payload.source : 'ClearRoute public price proxy' } : null;
}

export function CantonPriceChip() {
  const [quote, setQuote] = useState<{ value: number; change: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => { try { const response = await fetch(PRICE_URL, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(); const parsed = parseQuote(await response.json()); if (alive && parsed) setQuote(parsed); } catch { if (alive) setQuote(null); } };
    void refresh(); const timer = window.setInterval(refresh, 60_000); return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return <span className="home-price-chip"><span className="home-price-dot" />CC {quote ? `$${quote.value.toFixed(quote.value < 1 ? 4 : 2)}` : 'price unavailable'}{quote?.change != null && <strong>{quote.change >= 0 ? '+' : ''}{quote.change.toFixed(2)}%</strong>}</span>;
}

function MiniChart({ points }: { points: Point[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return '';
    const min = Math.min(...points.map(point => point.value)); const max = Math.max(...points.map(point => point.value)); const span = Math.max(max - min, 0.000001);
    return points.map((point, index) => { const x = (index / (points.length - 1)) * 300; const y = 48 - ((point.value - min) / span) * 36; return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  }, [points]);
  return <svg className="pulse-chart" viewBox="0 0 300 56" role="img" aria-label="Recent Canton Coin price samples"><path d="M0 48H300" /><path className="pulse-chart-line" d={path} /></svg>;
}

function EconomicsViz() {
  return <div className="economics-viz" aria-label="Canton Coin burn and mint telemetry visualization">
    <svg viewBox="0 0 460 150" role="img">
      <defs><linearGradient id="burnFlow" x1="0" x2="1"><stop stopColor="#e9876c" stopOpacity=".15" /><stop offset="1" stopColor="#e9876c" /></linearGradient><linearGradient id="mintFlow" x1="0" x2="1"><stop stopColor="#4bbf9a" stopOpacity=".15" /><stop offset="1" stopColor="#4bbf9a" /></linearGradient></defs>
      <path className="eco-grid" d="M18 25H442M18 75H442M18 125H442" />
      <path className="eco-track burn" d="M22 44 C92 18 130 68 190 48 S300 17 438 38" />
      <path className="eco-track mint" d="M22 108 C96 132 138 82 202 104 S310 130 438 98" />
      <path className="eco-flow burn" d="M22 44 C92 18 130 68 190 48 S300 17 438 38" />
      <path className="eco-flow mint" d="M22 108 C96 132 138 82 202 104 S310 130 438 98" />
      <circle className="eco-node burn-node" cx="22" cy="44" r="5" /><circle className="eco-node mint-node" cx="22" cy="108" r="5" />
      <g className="eco-center"><circle cx="230" cy="75" r="24" /><text x="230" y="81" textAnchor="middle">CC</text></g>
      <text className="eco-label burn-label" x="34" y="30">BURN · USAGE + FEES</text><text className="eco-label mint-label" x="34" y="139">MINT · ACTIVITY + REWARDS</text>
    </svg>
    <div className="economics-status"><span><i className="status-pulse waiting" />Scan aggregate awaiting configuration</span><b>MODEL VIEW</b></div>
  </div>;
}

export default function CantonPulse() {
  const [state, setState] = useState<Quote>({ value: null, change: null, checkedAt: null, points: [], source: 'Waiting for public price data' });
  const [pilot, setPilot] = useState<{ maxRequestCc: string; budgetCc: string; transfersEnabled: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const response = await fetch(PRICE_URL, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('price feed unavailable');
        const quote = parseQuote(await response.json());
        if (!quote || !alive) throw new Error('price unavailable');
        setState(previous => ({ value: quote.value, change: quote.change, checkedAt: Date.now(), source: quote.source, points: [...previous.points, { value: quote.value }].slice(-18) }));
      } catch {
        if (alive) setState(previous => ({ ...previous, checkedAt: Date.now(), source: 'Public feed unavailable — no value estimated' }));
      }
    };
    void refresh(); const timer = window.setInterval(refresh, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => { let alive = true; void fetch('/api/public-funding').then(response => response.ok ? response.json() : null).then(value => { if (alive && value) setPilot({ maxRequestCc: String(value.maxRequestCc), budgetCc: String(value.budgetCc), transfersEnabled: !!value.transfersEnabled }); }).catch(() => {}); return () => { alive = false; }; }, []);
  const price = state.value === null ? '—' : `$${state.value.toFixed(state.value < 1 ? 4 : 2)}`;
  const change = state.change === null ? '—' : `${state.change >= 0 ? '+' : ''}${state.change.toFixed(2)}%`;
  return <section className="canton-pulse" aria-label="Canton Network public pulse">
    <div className="pulse-heading"><div><span className="ops-kicker">PUBLIC CANTON PULSE</span><h2>Network signals, kept in view.</h2><p>Market context and network references for builders and treasury operators. Private contracts and wallet credentials stay behind the ClearRoute workspace.</p></div><span className="pulse-live"><i />LIVE VIEW</span></div>
    <div className="pulse-grid">
      <article className="pulse-price"><div className="pulse-label"><Wallet size={16} />Canton Coin · CC</div><strong>{price}</strong><span className={state.change !== null && state.change >= 0 ? 'up' : 'down'}>{change} <small>24h</small></span><MiniChart points={state.points} /><small className="pulse-source">{state.source}{state.checkedAt ? ` · checked ${new Date(state.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</small></article>
      <article className="pulse-insight pulse-economics"><div className="pulse-label"><Wallet size={16} />Devnet pilot</div><strong>Funding capacity</strong><p>ClearRoute’s public Devnet route is built for small, reviewed CC requests.</p><div className="pilot-readout"><div><span>PILOT BUDGET</span><b>{pilot ? `${pilot.budgetCc} CC` : '—'}</b></div><div><span>MAX REQUEST</span><b>{pilot ? `${pilot.maxRequestCc} CC` : '—'}</b></div></div><small className="pulse-source">{pilot ? `${pilot.transfersEnabled ? 'Transfers enabled' : 'Review-only mode'} · live server policy` : 'Loading server policy'}</small></article>
      <article className="pulse-insight pulse-economics"><div className="pulse-label mint-label"><ShieldCheck size={16} />ClearRoute guardrails</div><strong>Funding with control</strong><p>Every Devnet delivery is exact, reviewed, and accepted by the recipient. ClearRoute does not expose private contract data.</p><div className="guardrail-readout"><span>EXACT AMOUNT</span><span>OPERATOR REVIEW</span><span>RECIPIENT ACCEPTS</span></div><small className="pulse-source">Devnet CC only · recipient-controlled delivery</small></article>
    </div>
  </section>;
}
