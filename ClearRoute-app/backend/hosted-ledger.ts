import { AppError } from './money.js';
import type { Profile } from './networks.js';

export type LedgerCall = (profile: Profile, identity: Profile['provider'], route: string, body?: unknown) => Promise<any>;
export function hostedLedger(env: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch, resolveToken?: (name: string) => Promise<string | undefined>): LedgerCall {
  return async (profile, identity, route, body) => {
    const token = resolveToken ? await resolveToken(identity.tokenEnv) : env[identity.tokenEnv];
    if (!token || /\s/.test(token)) throw new AppError('LEDGER_CREDENTIAL_REQUIRED', 'The scoped ledger credential is missing or invalid.', 503);
    // Credentials are supplied by the host, rotated in its secret store and never returned to clients.
    if (!route.startsWith('/v2/') || route.includes('..')) throw new Error('Unsupported ledger route');
    let response: Response;
    try { response = await transport(profile.ledgerUrl.replace(/\/$/, '') + route, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    }); } catch { throw new AppError('LEDGER_UNCERTAIN', 'Ledger response unavailable. Reconcile the recorded command before submitting again.', 503); }
    const value = await response.text();
    if (value.length > 8_000_000) throw new AppError('LEDGER_RESPONSE_LIMIT', 'Ledger response exceeded the configured limit.', 502);
    if (!response.ok) {
      let detail = '';
      try { const code = JSON.parse(value).code; if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(code)) detail = code; } catch { /* Do not expose raw upstream responses or credentials. */ }
      throw new AppError('LEDGER_REJECTED', `Ledger returned HTTP ${response.status}${detail ? `: ${detail}` : ''}. Check the scoped identity and reconcile command outcomes.`, 502);
    }
    try { return value ? JSON.parse(value) : {}; } catch { throw new AppError('LEDGER_RESPONSE_INVALID', 'Ledger returned an invalid response.', 502); }
  };
}
export const transactionFormat = (parties: string[]) => ({ eventFormat: { filtersByParty: Object.fromEntries(parties.map(p => [p, { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] }])), verbose: true }, transactionShape: 'TRANSACTION_SHAPE_ACS_DELTA' });
