import { z } from 'zod';
import type { Network } from './networks.js';
export const PACKAGE_NAME = 'clearroute-service';
export const modules = {
  ServiceOffer: 'ClearRoute.Offer', ServiceAgreement: 'ClearRoute.Agreement', UsageAllowance: 'ClearRoute.Allowance',
  UsageReceipt: 'ClearRoute.UsageReceipt', DemoJob: 'ClearRoute.Demo', DemoCompletion: 'ClearRoute.Demo', Invoice: 'ClearRoute.Invoice',
  PaymentReceipt: 'ClearRoute.PaymentReceipt', InvoiceDispute: 'ClearRoute.Dispute', FundingReceipt: 'ClearRoute.FundingReceipt', TopUpReceipt: 'ClearRoute.TopUpReceipt',
} as const;
export type Template = keyof typeof modules;
export const templateId = (name: Template, packageId: string) => `${packageId}:${modules[name]}:${name}`;
export const networkValue = (network: Network) => ({ devnet: 'DevNet', testnet: 'TestNet', mainnet: 'MainNet' })[network];
const text = z.string().trim().min(1).max(300);
const time = z.string().datetime({ offset: true });
export const amount = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,10})?$/);
const units = z.string().regex(/^(0|[1-9]\d{0,14})$/);
const positiveUnits = units.refine(v => BigInt(v) > 0n);
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('offer'), tenantId: text, agreementId: text, mode: z.enum(['ManagedUsage', 'DirectTopUp']), termsRef: text, pricingPolicyVersion: text, exposureLimitUsd: amount.refine(v => Number(v) > 0), maxAllowanceUnits: positiveUnits, validUntil: time, acceptBefore: time }).strict(),
  z.object({ action: z.literal('accept'), contractId: text }).strict(),
  z.object({ action: z.literal('decline'), contractId: text }).strict(),
  z.object({ action: z.literal('withdraw'), contractId: text }).strict(),
  z.object({ action: z.literal('allowance'), contractId: text, allowanceId: text, units: positiveUnits, allowanceExpiresAt: time }).strict(),
  z.object({ action: z.literal('revoke'), contractId: text }).strict(),
  z.object({ action: z.literal('close'), contractId: text }).strict(),
  z.object({ action: z.literal('job'), contractId: text, jobId: text }).strict(),
  z.object({ action: z.literal('complete'), contractId: text, resultRef: text }).strict(),
  z.object({ action: z.literal('usage'), contractId: text, usageRef: text, completionRef: text, measuredUnits: units, measurementAt: time }).strict(),
  z.object({ action: z.literal('invoice'), contractId: text, invoiceId: text, periodStart: time, periodEnd: time, dueAt: time, lines: z.array(z.object({ chargeRef: text, usageRef: text, quoteRef: text, fixedUsd: amount }).strict()).min(1).max(100) }).strict(),
  z.object({ action: z.literal('payment'), contractId: text, paymentRef: text, evidenceRef: text, paymentRail: z.enum(['BankUSD', 'NativeUSDC', 'CantonUSDCx']), settledUsd: amount.refine(v => Number(v) > 0) }).strict(),
  z.object({ action: z.literal('dispute'), contractId: text, reason: text }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const choices: Record<Exclude<Action['action'], 'offer'>, { template: Template; choice: string; customer: boolean }> = {
  accept: { template: 'ServiceOffer', choice: 'Accept', customer: true }, decline: { template: 'ServiceOffer', choice: 'Decline', customer: true },
  withdraw: { template: 'ServiceOffer', choice: 'Withdraw', customer: false }, allowance: { template: 'ServiceAgreement', choice: 'IssueAllowance', customer: false },
  revoke: { template: 'UsageAllowance', choice: 'RevokeAllowance', customer: false }, close: { template: 'ServiceAgreement', choice: 'CloseAgreement', customer: false },
  job: { template: 'UsageAllowance', choice: 'SubmitDemoJob', customer: true }, complete: { template: 'DemoJob', choice: 'CompleteDemoJob', customer: false },
  usage: { template: 'UsageAllowance', choice: 'RecordMeasuredUsage', customer: false }, invoice: { template: 'ServiceAgreement', choice: 'IssueInvoice', customer: false },
  payment: { template: 'Invoice', choice: 'RecordVerifiedPayment', customer: false }, dispute: { template: 'Invoice', choice: 'DisputeInvoice', customer: true },
};
