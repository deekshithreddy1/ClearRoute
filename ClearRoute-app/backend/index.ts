import { IdentityStore } from './auth.js';
import { runtimeConfig } from './config.js';
import { mkdirSync } from 'node:fs';
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

const config = runtimeConfig();
const profiles = loadProfiles(config.profilesFile);
const { dataDir, port } = config;
mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, 'clearroute.sqlite'));
const identities = new IdentityStore(path.join(dataDir, 'identities.sqlite'));
const onboarding = new OnboardingStore(dataDir);
const operations = new Operations(path.join(dataDir, 'operations.sqlite'), config.networkMode === 'offline' ? {} : profiles);
// Offline is the default: no connector construction, polling or Canton calls.
const localnet = config.networkMode === 'localnet' ? new Localnet(dataDir, undefined, config.localnetConfig) : undefined;
const traffic = localnet ? new Traffic(dataDir) : undefined;
const metering = localnet ? new Metering(dataDir, () => localnet.meteringCommands(), undefined, config.localnetConfig) : undefined;
const sponsorship = localnet && traffic && metering ? new Sponsorship(dataDir, sponsorConnector(dataDir, traffic, localnet, metering, undefined, config.localnetConfig)) : undefined;
const walletFunding = localnet ? new WalletFunding(dataDir, walletConnector(config.localnetConfig)) : undefined;
const app = createApp(store, path.resolve('dist'), localnet, traffic, metering, sponsorship, { ...config, identities }, onboarding, walletFunding, operations);
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
if (traffic) poll('Traffic reconciliation', () => traffic.tick(), 5000);
if (metering) poll('Metering', () => metering.sync(), 15000);
const server = app.listen(port, config.host, () => console.log(`ClearRoute: http://${config.host}:${port}; authentication=${config.mode}; network=${config.networkMode}. Native funding requires a separately verified connector.`));
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  timers.forEach(clearInterval);
  server.close(async () => {
    await Promise.all(work);
    await operations.drain(); operations.close();
    walletFunding?.close(); sponsorship?.close(); metering?.close(); traffic?.close(); localnet?.close(); onboarding.close(); identities.close(); store.close();
    process.exit(0);
  });
});
