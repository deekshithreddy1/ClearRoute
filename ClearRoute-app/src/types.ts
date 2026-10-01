export type Session = 'operator' | 'atlas' | 'nova';
export type Page = 'Gas station' | 'Overview' | 'Managed usage' | 'CC Top-up' | 'Activity' | 'Invoices' | 'Settings' | 'LocalNet' | 'Traffic purchases' | 'Measured usage' | 'Billing';
export type Tenant = {
  id: string; name: string; partyId: string; status: string; limitUsd: string;
  unbilledUsd: string; outstandingUsd: string; allowanceBytes: number; usedBytes: number;
};
export type Usage = {
  id: string; tenantId: string; createdAt: string; description: string; trafficBytes: number;
  ccEquivalent: string; rateUsd: string; chargeUsd: string; status: string; reference: string;
};
export type Topup = {
  id: string; tenantId: string; createdAt: string; ccAmount: string; chargeUsd: string;
  status: string; reference: string;
};
export type Invoice = {
  id: string; tenantId: string; periodStart: string; periodEnd: string; createdAt: string;
  dueAt: string; totalUsd: string; paidUsd: string; status: string;
  lines: { description: string; amountUsd: string; reference: string }[];
};
export type FundingRequest = { id: string; tenantId: string; mode: string; status: string; createdAt: string; limitUsd: string };
export type AppState = {
  mode: 'demo'; environment: string; now: string; session: { role: string; tenantId?: string };
  tenants: Tenant[]; treasury?: { ccBalance: string; trafficBytes: number; spentCc: string } | null;
  quote: { id: string; usdPerCc: string; observedAt: string; expiresAt: string; source: string };
  usage: Usage[]; topups: Topup[]; invoices: Invoice[]; requests?: FundingRequest[];
  events: { id: string; at: string; type: string; message: string; tenantId?: string }[];
  readiness: { name: string; status: string; detail: string }[];
  policy: { label: string; topupTerms: string; billing: string; rate: string };
};
export type PendingMutation = { key: string; path: string; body: Record<string, unknown>; session: Session; label: string };
