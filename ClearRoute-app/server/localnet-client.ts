import { createHmac } from 'node:crypto';

// Only the bundled, disposable LocalNet uses this documented development key.
// Fixed loopback destinations deliberately prevent using this connector on a hosted network.
export const LEDGER = 'http://127.0.0.1:3975';
export function localToken(sub: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now()/1000);
  const unsigned = `${encode({alg:'HS256',typ:'JWT'})}.${encode({sub,aud:'https://canton.network.global',iat:now,exp:now+300})}`;
  return `${unsigned}.${createHmac('sha256','unsafe').update(unsigned).digest('base64url')}`;
}
export async function ledger(user: string, route: string, body?: unknown, binary?: Buffer): Promise<any> {
  const response = await fetch(LEDGER+route, {
    method: body !== undefined || binary ? 'POST' : 'GET', redirect:'error',
    headers: {Authorization:`Bearer ${localToken(user)}`, 'Content-Type':binary?'application/octet-stream':'application/json'},
    body: binary ? new Uint8Array(binary) : body === undefined ? undefined : JSON.stringify(body),
    signal:AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Ledger ${response.status}: ${text.slice(0,1200)}`);
  return text ? JSON.parse(text) : {};
}
export type LocalIdentity = {user: string; party: string};
export type LocalConfig = {provider: LocalIdentity; atlas: LocalIdentity; nova: LocalIdentity};
