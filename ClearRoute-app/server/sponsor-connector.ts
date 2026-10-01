import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ledger, type LocalConfig } from './localnet-client.js';
import { trafficTarget, type Traffic } from './traffic.js';
import type { Localnet } from './localnet.js';
import type { Metering } from './metering.js';
import type { SponsorDependencies } from './sponsorship.js';

export function sponsorConnector(directory: string, traffic: Pick<Traffic,'purchase'|'reconcile'|'get'>, localnet: Pick<Localnet,'run'>, metering: Pick<Metering,'sync'|'measurementForRun'>, connection = { ledger, trafficTarget }): SponsorDependencies {
  return {
    async binding(tenant) {
      const config: LocalConfig = JSON.parse(readFileSync(path.join(directory, 'localnet.json'), 'utf8'));
      const identity = config[tenant];
      const target = await connection.trafficTarget();
      // Both the customer and receiving validator must be hosted on the
      // participant used by this connector, not merely named in a local file.
      for (const party of [identity.party, target.party]) {
        const result = await connection.ledger('ledger-api-user', `/v2/parties/${encodeURIComponent(party)}`);
        if (!result.partyDetails?.some((p: any) => p.party === party && p.isLocal === true)) throw new Error('Sponsorship requires a party hosted on the configured provider participant.');
      }
      const rights = await connection.ledger('ledger-api-user', `/v2/users/${encodeURIComponent(identity.user)}/rights`);
      if (!rights.rights?.some((r: any) => r.kind?.CanActAs?.value?.party === identity.party)) throw new Error('The customer ledger user does not have the required scoped actAs right.');
      return { party: identity.party, user: identity.user, validator: target.party, domain: target.domain };
    },
    purchase: (bytes, key) => traffic.purchase(bytes, key),
    reconcilePurchase: id => traffic.reconcile(id),
    getPurchase: id => traffic.get(id),
    run: (tenant, key) => localnet.run(tenant, key),
    async measure(run) { await metering.sync(); return metering.measurementForRun(run); },
  };
}
