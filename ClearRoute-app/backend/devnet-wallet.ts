import { z } from 'zod';
import { AppError } from './money.js';

export const NODERS_WALLET = 'https://validator-api-http.validator.hackcanton-01.devnet.naas.noders.services/api/validator';
export const NODERS_LEDGER = 'https://ledger-api-json.participant.hackcanton-01.devnet.naas.noders.services';
export const DEVNET_DOMAIN = 'global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a';
export const partyId = z.string().trim().regex(/^[A-Za-z0-9:_\-.]{1,200}::1220[a-f0-9]{64}$/, 'Use the full Canton Party ID, not an EVM address.');
export const offerStatus = z.union([
  z.object({ status: z.enum(['created', 'accepted', 'completed']), transaction_id: z.string().min(1).max(500), contract_id: z.string().min(1).max(1000) }),
  z.object({ status: z.literal('failed'), failure_kind: z.enum(['expired', 'rejected', 'withdrawn']) }),
]);
export type Offer = { receiver_party_id: string; amount: string; description: string; tracking_id: string; expires_at: number };
export type WalletCheck = { party: string; balanceCc: string; checkedAt: string; synchronizer: string };
export interface DevnetWallet {
  credentialStatus?(): { mode: string; status: string; expiresAt: string | null; lastRenewedAt: string | null };
  check(): Promise<WalletCheck>;
  create(offer: Offer): Promise<unknown>;
  status(trackingId: string): Promise<z.infer<typeof offerStatus>>;
}
export class WalletReadError extends AppError {
  constructor(public upstreamStatus: number) { super('WALLET_RESPONSE', `Wallet returned HTTP ${upstreamStatus}. Check server credentials and reconcile before any new transfer.`, 502); }
}

/** Narrow Devnet-only connector. No caller-supplied URLs or recipient credentials. */
export class NodersDevnetWallet implements DevnetWallet {
  constructor(private expectedParty: string, private token: () => string | undefined | Promise<string | undefined>, private transport: typeof fetch = fetch, public credentialStatus?: DevnetWallet['credentialStatus']) { partyId.parse(expectedParty); }
  private async call(base: string, route: string, body?: unknown) {
    const token = await this.token();
    if (!token) throw new AppError('WALLET_TOKEN_MISSING', 'Set CLEARROUTE_DEVNET_WALLET_TOKEN on the server and restart.', 503);
    const response = await this.transport(base + route, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new WalletReadError(response.status);
    return response.json();
  }
  async check(): Promise<WalletCheck> {
    const wallet = z.object({ party_id: z.string(), user_onboarded: z.literal(true), user_wallet_installed: z.literal(true) }).parse(await this.call(NODERS_WALLET, '/v0/wallet/user-status'));
    if (wallet.party_id !== this.expectedParty) throw new AppError('TREASURY_MISMATCH', 'Authenticated wallet does not match the configured treasury party.', 409);
    const connected = z.object({ connectedSynchronizers: z.array(z.object({ synchronizerId: z.string(), permission: z.string() })) }).parse(await this.call(NODERS_LEDGER, '/v2/state/connected-synchronizers?party=' + encodeURIComponent(wallet.party_id)));
    if (!connected.connectedSynchronizers.some(s => s.synchronizerId === DEVNET_DOMAIN && s.permission === 'PARTICIPANT_PERMISSION_SUBMISSION')) throw new AppError('WRONG_NETWORK', 'Treasury is not connected for submission to the verified Devnet synchronizer.', 409);
    const balance = z.object({ effective_unlocked_qty: z.string().regex(/^\d+(\.\d{1,10})?$/) }).parse(await this.call(NODERS_WALLET, '/v0/wallet/balance'));
    z.object({ offers: z.array(z.unknown()) }).parse(await this.call(NODERS_WALLET, '/v0/wallet/transfer-offers'));
    return { party: wallet.party_id, balanceCc: balance.effective_unlocked_qty, checkedAt: new Date().toISOString(), synchronizer: DEVNET_DOMAIN };
  }
  create(offer: Offer) { return this.call(NODERS_WALLET, '/v0/wallet/transfer-offers', offer); }
  async status(id: string) { return offerStatus.parse(await this.call(NODERS_WALLET, '/v0/wallet/transfer-offers/' + encodeURIComponent(id) + '/status', {})); }
}
