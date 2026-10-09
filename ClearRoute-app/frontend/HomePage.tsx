import { ArrowRight, ShieldCheck, Wallet } from 'lucide-react';
import { BrandLogo, DnaArt } from './Brand';
import CantonPulse, { CantonPriceChip } from './CantonPulse';
import './public-funding.css';
import './operations.css';

export default function HomePage() {
  return <div className="funding-public clearroute-home"><header className="funding-header"><a href="/" aria-label="ClearRoute home"><BrandLogo /></a><nav><CantonPriceChip /><a href="/login">Sign in</a><a className="home-nav-cta" href="/funding">Request Devnet CC</a></nav></header>
    <main className="home-layout"><section className="home-copy"><span className="ops-kicker">CANTON NETWORK FUNDING LAYER</span><h1>Keep building.<br /><em>Keep moving.</em></h1><p>ClearRoute helps early Canton teams receive the CC they need to test transactions, with a reviewed destination, a visible delivery record, and billing that stays connected to usage.</p><div className="home-actions"><a className="ops-button" href="/funding">Request Devnet CC <ArrowRight size={16} /></a><a className="home-secondary" href="/login">Open workspace</a></div><div className="home-trust"><span><Wallet size={16} />Direct CC delivery</span><span><ShieldCheck size={16} />Operator-reviewed</span></div></section><section className="home-art"><DnaArt /><span>CC / THE DNA OF YOUR NEXT MOVE</span></section></main>
    <section className="home-steps"><article><b>01</b><h2>Register your destination</h2><p>Provide your full Canton party ID and wallet provider.</p></article><article><b>02</b><h2>Pass review</h2><p>ClearRoute verifies the destination and requested amount.</p></article><article><b>03</b><h2>Receive CC</h2><p>Accept the Splice offer in your wallet and continue building.</p></article></section><CantonPulse />
    <footer className="funding-footer">ClearRoute / Funding the next Canton transaction.</footer>
  </div>;
}
