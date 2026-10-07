import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const networkName = z.enum(['devnet', 'testnet', 'mainnet']);
export type Network = z.infer<typeof networkName>;
export const networks: Network[] = ['devnet', 'testnet', 'mainnet'];
export const tenantKey = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
const identity = z.object({ userId: z.string().min(1).max(255), partyId: z.string().min(10).max(300), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{2,100}$/) }).strict();
const httpsEndpoint = z.string().url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '') || /^(localhost|127\.|\[?::1)/i.test(url.hostname))
    ctx.addIssue({ code: 'custom', message: 'Use a hosted HTTPS origin without credentials, query or path.' });
});
export const profileSchema = z.object({
  ledgerUrl: httpsEndpoint, participantId: z.string().min(10).max(300), synchronizerId: z.string().min(10).max(300),
  packageId: z.string().regex(/^[a-f0-9]{64}$/), writesEnabled: z.boolean().default(false),
  provider: identity,
  customers: z.record(tenantKey, identity.extend({ name: z.string().min(1).max(100) }).strict()).default({}),
}).strict().superRefine((p, ctx) => {
  const parties = [p.provider.partyId, ...Object.values(p.customers).map(i => i.partyId)];
  if (new Set(parties).size !== parties.length) ctx.addIssue({ code: 'custom', message: 'Provider and customers must have distinct parties.' });
  const tokenNames = [p.provider.tokenEnv, ...Object.values(p.customers).map(i => i.tokenEnv)];
  if (new Set(tokenNames).size !== tokenNames.length) ctx.addIssue({ code: 'custom', message: 'Use independently scoped token references per identity.' });
  const users = [p.provider.userId, ...Object.values(p.customers).map(i => i.userId)];
  if (new Set(users).size !== users.length) ctx.addIssue({ code: 'custom', message: 'Use independently scoped ledger users per identity.' });
});
export type Profile = z.infer<typeof profileSchema>;
export type Profiles = Partial<Record<Network, Profile>>;
export function loadProfiles(file?: string, env: NodeJS.ProcessEnv = process.env): Profiles {
  if (!file) return {};
  const profiles = z.object({ devnet: profileSchema.optional(), testnet: profileSchema.optional(), mainnet: profileSchema.optional() }).strict().parse(JSON.parse(readFileSync(file, 'utf8')));
  if (profiles.mainnet?.writesEnabled && env.CLEARROUTE_MAINNET_WRITES !== 'ENABLED') throw new Error('Mainnet writes require CLEARROUTE_MAINNET_WRITES=ENABLED.');
  const destinations = Object.values(profiles).map(p => new URL(p.ledgerUrl).origin);
  if (new Set(destinations).size !== destinations.length) throw new Error('Network profiles must use separate ledger destinations.');
  return profiles;
}
