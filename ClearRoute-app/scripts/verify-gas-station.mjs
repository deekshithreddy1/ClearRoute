import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runtimeConfig } from '../dist-backend/config.js';
import { Localnet } from '../dist-backend/localnet.js';
import { Traffic } from '../dist-backend/traffic.js';
import { Metering } from '../dist-backend/metering.js';
import { Sponsorship } from '../dist-backend/sponsorship.js';
import { sponsorConnector } from '../dist-backend/sponsor-connector.js';

if(!process.argv.includes('--execute'))throw new Error('Pass --execute to buy one minimum LocalNet traffic batch and execute the Atlas test workflow.');
const config=runtimeConfig();
if(config.networkMode!=='localnet')throw new Error('Set CLEARROUTE_NETWORK_MODE=localnet and CLEARROUTE_LOCALNET_CONFIG.');
mkdirSync(config.dataDir,{recursive:true});
const localnet=new Localnet(config.dataDir,undefined,config.localnetConfig);
const traffic=new Traffic(config.dataDir);
const metering=new Metering(config.dataDir,()=>localnet.meteringCommands(),undefined,config.localnetConfig);
const sponsorship=new Sponsorship(config.dataDir,sponsorConnector(config.dataDir,traffic,localnet,metering,undefined,config.localnetConfig));
try {
  const state=await traffic.state();if(!state.target||state.error)throw new Error(state.error || 'Treasury unavailable');
  await sponsorship.approve('atlas',{enabled:true,batchBytes:state.target.minBytes,capacityLimitBytes:state.target.minBytes});
  let result=await sponsorship.submit('atlas','mvp-gas-station-v1');
  for(let n=0;n<36&&!['completed','funding_failed'].includes(result.status);n++){
    await new Promise(resolve=>setTimeout(resolve,5000));await sponsorship.reconcile(result.id);result=sponsorship.get(result.id,'atlas');
    console.log(`Sponsorship ${result.id}: ${result.status}${result.error ? ' - '+result.error : ''}`);
  }
  if(result.status!=='completed'||!result.measurement?.complete)throw new Error(`Sponsored workflow not verified: ${JSON.stringify(result)}`);
  const replay=await sponsorship.submit('atlas','mvp-gas-station-v1');if(replay.id!==result.id)throw new Error('Sponsorship replay changed identity.');
  const purchase=traffic.get(result.purchase.id);
  if(!purchase.evidence?.purchase)throw new Error('Native purchase receipt missing.');
  const destination=path.join(config.dataDir,'gas-station-evidence.json');
  writeFileSync(destination,JSON.stringify({network:'LocalNet',verifiedAt:new Date().toISOString(),result,purchase,ledgerRuns:localnet.list('atlas')},null,2)+'\n');
  console.log(JSON.stringify({ok:true,requestId:result.id,measurement:result.measurement,purchase:purchase.evidence.purchase,evidence:destination},null,2));
} finally {sponsorship.close();metering.close();traffic.close();localnet.close();}
