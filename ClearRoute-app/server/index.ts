import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { createApp } from './app.js';
import { Localnet } from './localnet.js';
import { Traffic } from './traffic.js';
import { Metering } from './metering.js';
import { Sponsorship } from './sponsorship.js';
import { sponsorConnector } from './sponsor-connector.js';

if (process.env.LAUNCHFUEL_MODE && process.env.LAUNCHFUEL_MODE !== 'demo') {
  throw new Error('This application release supports local demo mode only. Live operation requires the documented host integration and release review.');
}
const dataDir = path.resolve(process.env.LAUNCHFUEL_DATA_DIR ?? 'data');
mkdirSync(dataDir,{recursive:true});
const store = new Store(path.join(dataDir,'launchfuel.sqlite'));
const localnet = new Localnet(dataDir);
const traffic = new Traffic(dataDir);
const metering = new Metering(dataDir,()=>localnet.meteringCommands());
const sponsorship = new Sponsorship(dataDir,sponsorConnector(dataDir,traffic,localnet,metering));
const app = createApp(store,path.resolve('dist'),localnet,traffic,metering,sponsorship);
let sponsorWork:Promise<void>|null=null;
const sponsorTimer=setInterval(()=>{if(!sponsorWork)sponsorWork=sponsorship.tick().catch(e=>console.error('Sponsorship:',e)).finally(()=>{sponsorWork=null;});},5000);sponsorTimer.unref();
let meteringWork:Promise<void>|null=null;
const pollMetering=()=>{if(!meteringWork)meteringWork=metering.sync().catch(e=>console.error('Metering:',e)).finally(()=>{meteringWork=null;});};
const meteringTimer=setInterval(pollMetering,15000);meteringTimer.unref();pollMetering();
let trafficWork:Promise<void>|null=null;
const pollTraffic=()=>{if(!trafficWork)trafficWork=traffic.tick().catch(e=>console.error('Traffic reconciliation:',e)).finally(()=>{trafficWork=null;});};
const trafficTimer=setInterval(pollTraffic,5000);trafficTimer.unref();pollTraffic();
const port = Number(process.env.PORT ?? 3001);
if (![3001].includes(port)) throw new Error('This demo is configured for local port 3001. Update origin validation when changing ports.');
const server = app.listen(port,'127.0.0.1',()=>console.log(`LaunchFuel local demo: http://127.0.0.1:${port}. Simulated network, prices, and payments; no real funds.`));
for (const signal of ['SIGTERM','SIGINT'] as const) process.on(signal,()=>{clearInterval(sponsorTimer);clearInterval(trafficTimer);clearInterval(meteringTimer);server.close(async()=>{await Promise.all([sponsorWork,trafficWork,meteringWork]);sponsorship.close();metering.close();traffic.close();localnet.close();store.close();process.exit(0);});});
