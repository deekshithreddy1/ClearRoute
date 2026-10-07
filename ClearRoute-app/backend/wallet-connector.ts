import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { localToken, ledger, type LocalConfig } from './localnet-client.js';
import { trafficTarget } from './traffic.js';
import { WalletApiError } from './wallet-adapter.js';
import type { FundingDependencies } from './wallet-funding.js';

// Compatibility adapter for the bundled LocalNet only. Commercial integration
// must use Token Standard APIs; legacy wallet transfer offers are deprecated.
export async function localWallet(user: string, route: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:3903/api/validator/${route}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${localToken(user)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new WalletApiError(response.status, `LocalNet wallet request failed (${response.status}).`);
  const text = await response.text(); return text ? JSON.parse(text) : {};
}
export function walletConnector(configFile: string): FundingDependencies {
  return {
    async binding(tenant) {
      if (tenant !== 'atlas' && tenant !== 'nova') throw new Error('Unknown configured wallet.');
      const config: LocalConfig = JSON.parse(readFileSync(configFile, 'utf8'));
      const identity = config[tenant];
      const target = await trafficTarget(); // Verifies loopback LocalNet, isDevNet and provider identity.
      const status = await localWallet(identity.user, 'v0/wallet/user-status');
      if (status.party_id !== identity.party || !status.user_onboarded || !status.user_wallet_installed) throw new Error(`${tenant} wallet is not installed for its configured party. Run wallet:setup for LocalNet.`);
      const balance = await localWallet(identity.user, 'v0/wallet/balance');
      return { sender: { user: 'app-provider', party: target.party, balanceCc: target.balanceCc }, receiver: { ...identity, balanceCc: z.string().regex(/^\d+(\.\d+)?$/).parse(balance.effective_unlocked_qty) }, domain: target.domain };
    },
    create: (b, request) => localWallet(b.sender.user, 'v0/wallet/transfer-offers', request),
    status: (b, id) => localWallet(b.sender.user, `v0/wallet/transfer-offers/${encodeURIComponent(id)}/status`, {}),
    accept: (b, id) => localWallet(b.receiver.user, `v0/wallet/transfer-offers/${encodeURIComponent(id)}/accept`, {}),
    evidence: (b, id) => ledger(b.sender.user, '/v2/updates/transaction-by-id', { updateId: id, transactionFormat: { transactionShape: 'TRANSACTION_SHAPE_LEDGER_EFFECTS', eventFormat: { filtersByParty: { [b.sender.party]: {} }, verbose: true } } }),
  };
}
