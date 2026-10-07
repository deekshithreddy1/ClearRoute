import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { IdentityStore } from './auth.js';
import { z } from 'zod';
import { tenantKey } from './networks.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, tenant: { type: 'string' }, days: { type: 'string' },
} });
const directory = path.resolve(process.env.CLEARROUTE_DATA_DIR ?? 'data');
mkdirSync(directory, { recursive: true });
const identities = new IdentityStore(path.join(directory, 'identities.sqlite'));
try {
  if (positionals.length !== 1) throw new Error('Supply one command: create, issue, revoke, disable, or list.');
  const id = () => z.string().min(1).parse(values.id);
  switch (positionals[0]) {
    case 'create': {
      const role = z.enum(['operator', 'customer']).parse(values.role);
      if (role === 'operator' && values.tenant) throw new Error('Operator accounts cannot have a customer tenant.');
      console.log(identities.createAccount(role === 'operator'
        ? { id: id(), name: z.string().parse(values.name), role, tenantId: null }
        : { id: id(), name: z.string().parse(values.name), role, tenantId: tenantKey.parse(values.tenant) }));
      break;
    }
    case 'issue': console.log('Store this access key securely. It is shown only once.\n' + JSON.stringify(identities.issueKey(id(), values.days ? Number(values.days) : 30), null, 2)); break;
    case 'revoke': identities.revokeKey(id()); console.log('Credential revoked, including its browser sessions.'); break;
    case 'disable': identities.disableAccount(id()); console.log('Account disabled.'); break;
    case 'list': console.log(JSON.stringify({ accounts: identities.listAccounts(), credentials: identities.listKeys() }, null, 2)); break;
    default: throw new Error('Unknown command. Use create, issue, revoke, disable, or list.');
  }
} finally { identities.close(); }
