import { z } from 'zod';
import { apiFetch } from './http';
export type Network = 'devnet' | 'testnet' | 'mainnet';
export type Identity = { id: string; name: string; role: 'operator' | 'customer'; tenantId: string | null };
const month = z.object({ month: z.string(), invoicedUsd: z.string(), collectedUsd: z.string(), burnedCc: z.string(), transferredCc: z.string(), usageUnits: z.string(), records: z.number() });
export const operationsSchema = z.object({
  network: z.enum(['devnet', 'testnet', 'mainnet']), configured: z.boolean(), writesEnabled: z.boolean(), packageId: z.string().nullable(), packageName: z.string(),
  health: z.object({ status: z.string(), checkedAt: z.string().nullable(), detail: z.string() }),
  accounts: z.array(z.object({ tenant: z.string(), name: z.string(), party: z.string(), status: z.string(), limitUsd: z.string(), maxUnits: z.string() })),
  requests: z.array(z.object({ id: z.string(), tenant: z.string(), mode: z.string(), amount: z.string(), reason: z.string(), status: z.string(), createdAt: z.string(), decision: z.string().nullable() })).default([]),
  recipients: z.array(z.object({ requestId: z.string(), company: z.string(), email: z.string(), partyId: z.string(), validator: z.string(), ownershipReference: z.string() })).default([]),
  contracts: z.array(z.object({ id: z.string(), template: z.string(), tenant: z.string(), createdAt: z.string(), updateId: z.string(), payload: z.record(z.unknown()) })),
  commands: z.array(z.object({ id: z.string(), tenant: z.string(), action: z.string(), status: z.string(), error: z.string().nullable(), createdAt: z.string(), result: z.object({ updateId: z.string(), offset: z.string() }).nullable() })),
  audit: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), kind: z.string(), tenant: z.string().nullable(), detail: z.unknown() })),
  capabilities: z.object({ serviceContracts: z.boolean(), nativeTransfers: z.boolean(), trafficPurchases: z.boolean(), balance: z.string() }),
  analytics: z.object({ monthly: z.array(month), currentMonth: z.string(), currentMonthPartial: z.boolean(), growthPercent: z.number().nullable(),
    settings: z.object({ growthPercent: z.number(), reserveDays: z.number(), leadDays: z.number(), minimumCc: z.string() }),
    treasury: z.object({ balanceCc: z.string(), observedAt: z.string(), evidenceRef: z.string(), source: z.string(), stale: z.boolean() }).passthrough().nullable(),
    forecast: z.object({ baselineCc: z.string(), nextMonthCc: z.string(), targetCc: z.string(), suggestedPurchaseCc: z.string().nullable(), runwayDays: z.number().nullable(), observedMonths: z.number(), source: z.string() }),
    provenance: z.string(),
  }).nullable(),
});
export type OperationsState = z.infer<typeof operationsSchema>;
export class OperationError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function operationRequest(path: string, body?: unknown, key?: string) {
  const response = await apiFetch(`/api/operations/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new OperationError(data.error?.message || `Request failed (${response.status}).`, response.status);
  return data;
}
