import type { OperationsState } from '../../frontend/operations-api';
export const operationsState: OperationsState = {
  network: 'devnet', configured: true, writesEnabled: false, packageName: 'clearroute-service', packageId: 'a'.repeat(64),
  health: { status: 'unchecked', checkedAt: null, detail: 'Not checked' }, accounts: [{ tenant: 'atlas', name: 'Atlas Labs', party: 'atlas::test-party', status: 'pending', limitUsd: '100', maxUnits: '100' }],
  recipients: [], contracts: [], commands: [], audit: [], requests: [],
  capabilities: { serviceContracts: true, nativeTransfers: false, trafficPurchases: false, balance: 'operator-attested' },
  analytics: {
    monthly: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map(month => ({ month, invoicedUsd: '0.00', collectedUsd: '0.00', burnedCc: '0.00', transferredCc: '0.00', usageUnits: '0.00', records: 0 })),
    currentMonth: '2026-10', currentMonthPartial: true, growthPercent: null,
    settings: { growthPercent: 20, reserveDays: 30, leadDays: 7, minimumCc: '0' }, treasury: null,
    forecast: { baselineCc: '0', nextMonthCc: '0', targetCc: '0', suggestedPurchaseCc: null, runwayDays: null, observedMonths: 0, source: 'Three complete months and a fresh observation required.' },
    provenance: 'Indexed attestations only. Current month is partial.',
  },
};
