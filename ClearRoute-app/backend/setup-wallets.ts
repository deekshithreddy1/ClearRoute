import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runtimeConfig } from './config.js';
import { ledger, type LocalConfig } from './localnet-client.js';
import { trafficTarget } from './traffic.js';
import { localWallet, walletConnector } from './wallet-connector.js';

const runtime = runtimeConfig();
if (runtime.networkMode !== 'localnet') throw new Error('Set CLEARROUTE_NETWORK_MODE=localnet explicitly before installing test wallets.');
await trafficTarget();
const config: LocalConfig = JSON.parse(readFileSync(runtime.localnetConfig, 'utf8'));
for (const tenant of ['atlas','nova'] as const) {
  const user = `clearroute-wallet-${tenant}`;
  const users = await localWallet('ledger-api-user', 'v0/admin/users');
  let party = config[tenant].party;
  if (!users.usernames?.includes(user)) {
    // The validator must allocate a fresh party and install its wallet. Passing
    // an existing Ledger API party here is rejected by the LocalNet wallet app.
    const result = await localWallet('ledger-api-user', 'v0/admin/users', { name: user });
    party = result.party_id;
  } else {
    const parties = await ledger('ledger-api-user', '/v2/parties?pageSize=1000');
    party = parties.partyDetails.find((p: any) => p.party.startsWith(`${user}::`))?.party;
    if (!party) throw new Error(`Wallet user ${user} exists but its party is missing.`);
  }
  config[tenant] = { user, party };
  mkdirSync(path.dirname(runtime.localnetConfig), { recursive: true });
  writeFileSync(runtime.localnetConfig, JSON.stringify(config, null, 2) + '\n');
  const binding = await walletConnector(runtime.localnetConfig).binding(tenant);
  console.log(JSON.stringify({ tenant, party: binding.receiver.party, balanceCc: binding.receiver.balanceCc }));
}
console.log('LocalNet customer wallets installed. No CC transfers requested.');
