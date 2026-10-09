import { IdentityStore } from './auth.js';
import { runtimeConfig } from './config.js';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';
import { Localnet } from './localnet.js';
import { Traffic } from './traffic.js';
import { Metering } from './metering.js';
import { Sponsorship } from './sponsorship.js';
import { sponsorConnector } from './sponsor-connector.js';
import { OnboardingStore } from './onboarding.js';
import { WalletFunding } from './wallet-funding.js';
import { walletConnector } from './wallet-connector.js';
import { loadProfiles } from './networks.js';
import { Operations } from './operations.js';
import { PublicFunding } from './public-funding.js';
import { NodersDevnetWallet } from './devnet-wallet.js';
import { CredentialBroker } from './oidc.js';
import { hostedLedger } from './hosted-ledger.js';

const config = runtimeConfig();
const profiles = loadProfiles(config.profilesFile);
const { dataDir, port } = config;
mkdirSync(dataDir, { recursive: true });
const broker = config.hosted && process.env.CLEARROUTE_OIDC_CONFIG_FILE
  ? new CredentialBroker(JSON.parse(readFileSync(process.env.CLEARROUTE_OIDC_CONFIG_FILE, 'utf8')), path.join(dataDir, 'credentials', 'renewal.enc.json')) : undefined;
for (const profile of Object.values(profiles)) for (const identity of [profile.provider, ...Object.values(profile.customers)]) {
  const expected = broker?.expectedSubject(identity.tokenEnv);
  if (expected && expected !== identity.userId) throw new Error('Renewal profile subject must match the configured ledger user.');
}
const store = new Store(path.join(dataDir, 'clearroute.sqlite'));
const identities = new IdentityStore(path.join(dataDir, 'identities.sqlite'));
const onboarding = new OnboardingStore(dataDir);
const operations = new Operations(path.join(dataDir, 'operations.sqlite'), config.networkMode === 'offline' ? {} : profiles, hostedLedger(process.env, fetch, broker ? name => broker.get(name) : undefined));
// Offline is the default: no connector construction, polling or Canton calls.
const localnet = config.networkMode === 'localnet' ? new Localnet(dataDir, undefined, config.localnetConfig) : undefined;
const traffic = localnet ? new Traffic(dataDir) : undefined;
const metering = localnet ? new Metering(dataDir, () => localnet.meteringCommands(), undefined, config.localnetConfig) : undefined;
const sponsorship = localnet && traffic && metering ? new Sponsorship(dataDir, sponsorConnector(dataDir, traffic, localnet, metering, undefined, config.localnetConfig)) : undefined;
const walletFunding = localnet ? new WalletFunding(dataDir, walletConnector(config.localnetConfig)) : undefined;
if (process.env.CLEARROUTE_PUBLIC_FUNDING === '1' && config.networkMode !== 'devnet') throw new Error('Public funding is available only in Devnet mode.');
const publicWallet = config.networkMode === 'devnet' && process.env.CLEARROUTE_DEVNET_TREASURY_PARTY
  ? new NodersDevnetWallet(process.env.CLEARROUTE_DEVNET_TREASURY_PARTY, () => broker ? broker.get('CLEARROUTE_DEVNET_WALLET_TOKEN') : process.env.CLEARROUTE_DEVNET_WALLET_TOKEN, fetch, () => broker?.status('CLEARROUTE_DEVNET_WALLET_TOKEN') ?? { mode: 'manual', status: 'manual_token', expiresAt: null, lastRenewedAt: null }) : undefined;
const publicFunding = process.env.CLEARROUTE_PUBLIC_FUNDING === '1' ? new PublicFunding(path.join(dataDir, 'public-funding.sqlite'), publicWallet, process.env.CLEARROUTE_DEVNET_TRANSFERS === 'ENABLED', Date.now, (requestId, party, amount, recordedAt, evidence) => operations.recordPublicTransfer('devnet', requestId, party, amount, recordedAt, evidence)) : undefined;
const app = createApp(store, path.resolve('dist'), localnet, traffic, metering, sponsorship, { ...config, identities }, onboarding, walletFunding, operations, publicFunding);
const timers: ReturnType<typeof setInterval>[] = [];
const work = new Set<Promise<void>>();
function poll(label: string, task: () => Promise<unknown>, interval: number) {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    const current = task().then(() => {}, () => { console.error(`${label} failed; inspect the operation status before retrying.`); }).finally(() => { busy = false; work.delete(current); });
    work.add(current);
  };
  const timer = setInterval(run, interval); timer.unref(); timers.push(timer); run();
}
if (sponsorship) poll('Sponsorship reconciliation', () => sponsorship.tick(), 5000);
if (walletFunding) poll('Wallet transfer reconciliation', () => walletFunding.tick(), 5000);
if (publicFunding) poll('Devnet public transfer reconciliation', () => publicFunding.tick(), 20000);
if (broker) poll('Credential renewal', () => broker.tick(), 30000);
if (traffic) poll('Traffic reconciliation', () => traffic.tick(), 5000);
if (metering) poll('Metering', () => metering.sync(), 15000);
poll('Automatic 15-day invoice closing', () => { store.autoCloseDuePeriods(); return Promise.resolve(); }, 60000);
const server = app.listen(port, config.host, () => console.log(`ClearRoute: http://${config.host}:${port}; authentication=${config.mode}; network=${config.networkMode}. Native funding requires a separately verified connector.`));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  timers.forEach(clearInterval);
  server.close(async () => {
    await Promise.all(work);
    await broker?.drain();
    await operations.drain(); operations.close();
    publicFunding?.close(); walletFunding?.close(); sponsorship?.close(); metering?.close(); traffic?.close(); localnet?.close(); onboarding.close(); identities.close(); store.close();
    process.exit(0);
  });
});
