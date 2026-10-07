import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ledger, type LocalIdentity } from './localnet-client.js';
import path from 'node:path';
import { runtimeConfig } from './config.js';

// Run explicitly from the app directory. Admin credentials are never sent to the browser.
const runtime = runtimeConfig();
if (runtime.networkMode !== 'localnet') throw new Error('Set CLEARROUTE_NETWORK_MODE=localnet before ledger setup.');
await ledger('ledger-api-user','/v2/packages?vetAllPackages=true',undefined,
  readFileSync(process.env.CLEARROUTE_DAR_PATH ?? '../daml/clearroute/.daml/dist/clearroute-0.1.0.dar'));
const config: Record<string,LocalIdentity> = {};
for (const name of ['provider','atlas','nova']) {
  const user = `clearroute-local-${name}`;
  let existing: any;
  try { existing = await ledger('ledger-api-user',`/v2/users/${user}`); }
  catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Ledger 404:')) throw error; }
  if (!existing) await ledger('ledger-api-user','/v2/users',{user:{id:user},rights:[]});
  const parties = await ledger('ledger-api-user','/v2/parties?pageSize=1000');
  let party = parties.partyDetails.find((p:any)=>p.party.startsWith(user+'::'))?.party;
  if (!party) party = (await ledger('ledger-api-user','/v2/parties',{partyIdHint:user,userId:user})).partyDetails.party;
  await ledger('ledger-api-user',`/v2/users/${user}/rights`,{userId:user,rights:[{kind:{CanActAs:{value:{party}}}}]});
  config[name] = {user,party};
  console.log(`Ready: ${name} (dedicated local party and scoped ledger user)`);
}
mkdirSync(path.dirname(runtime.localnetConfig),{recursive:true});
writeFileSync(runtime.localnetConfig,JSON.stringify(config,null,2)+'\n');
console.log(`DAR uploaded and vetted. LocalNet identities saved to ${runtime.localnetConfig}. No funds moved.`);
