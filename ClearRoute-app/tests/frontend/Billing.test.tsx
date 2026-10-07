import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import Billing from '../../frontend/Billing';

const invoice = { id: 'invoice-1', tenant: 'atlas', totalUsd: '1.00', outstandingUsd: '1.00', status: 'issued', periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-16T00:00:00Z', payments: [] as { id: string; reference: string; amountUsd: string; status: string }[] };
const preview = { id: 'preview-1', tenant: 'nova', totalUsd: '2.00', periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-09-16T00:00:00Z' };
const state = { now: '2026-09-20T00:00:00Z', invoices: [invoice], audit: [], lateUsage: [] };
function fixtures(post: (options: RequestInit) => Promise<Response> = async () => Response.json({ ok: true }), billing = state) {
  return vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') return post(options);
    if (url === '/api/billing') return Response.json(billing);
    if (url === '/api/metering') return Response.json({ invoices: [preview] });
    throw new Error(`Unexpected request ${url}`);
  });
}

test('customers see invoice details without operator controls', async () => {
  fixtures(); render(<Billing session="atlas" />);
  await screen.findByText('Outstanding: 1.00 USD');
  expect(screen.queryByRole('button', { name: /Record sandbox payment/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Finalize/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Advance/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Export invoice/ })).toBeTruthy();
});

test('operator finalizes exactly the reviewed preview with an idempotency key', async () => {
  const mock = fixtures(); const user = userEvent.setup(); render(<Billing session="operator" />);
  await user.click(await screen.findByRole('button', { name: 'Finalize reviewed preview' }));
  await waitFor(() => expect(mock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true));
  const [url, options] = mock.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(url).toBe('/api/billing/finalize');
  expect(JSON.parse(options!.body as string)).toEqual({ tenantId: 'nova', periodStart: preview.periodStart, previewId: preview.id });
  expect((options!.headers as Record<string, string>)['idempotency-key']).toBeTruthy();
});

test('uncertain payment response persists across remount and reuses identical request', async () => {
  let attempts = 0;
  const mock = fixtures(async () => { if (++attempts === 1) return Response.json({ error: { message: 'Result unknown' } }, { status: 503 }); return Response.json({ ok: true }); });
  const user = userEvent.setup(); const view = render(<Billing session="operator" />);
  await user.type(await screen.findByLabelText('Payment amount USD'), '0.25');
  await user.type(screen.getByLabelText('Payment reference'), 'BANK-123');
  await user.click(screen.getByRole('button', { name: 'Record sandbox payment' }));
  await screen.findByRole('button', { name: 'Retry saved operation' });
  expect(localStorage.getItem('clearroute.billing.pending.operator')).toContain('BANK-123');
  view.unmount(); render(<Billing session="operator" />);
  await user.click(await screen.findByRole('button', { name: 'Retry saved operation' }));
  await waitFor(() => expect(attempts).toBe(2));
  const requests = mock.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(requests[1][0]).toBe(requests[0][0]);
  expect(requests[1][1]?.body).toBe(requests[0][1]?.body);
  expect(requests[1][1]?.headers).toEqual(requests[0][1]?.headers);
  await waitFor(() => expect(localStorage.getItem('clearroute.billing.pending.operator')).toBeNull());
});

test('validation rejection releases saved operation and shows actionable error', async () => {
  fixtures(async () => Response.json({ error: { message: 'Period is still open' } }, { status: 400 }));
  const user = userEvent.setup(); render(<Billing session="operator" />);
  await user.click(await screen.findByRole('button', { name: 'Finalize reviewed preview' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Period is still open');
  expect(localStorage.getItem('clearroute.billing.pending.operator')).toBeNull();
});

test('open billing periods cannot be finalized', async () => {
  fixtures(undefined, { ...state, now: '2026-09-02T00:00:00Z' }); render(<Billing session="operator" />);
  expect((await screen.findByRole('button', { name: 'Finalize reviewed preview' }) as HTMLButtonElement).disabled).toBe(true);
});

test('failed initial load can recover through refresh', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('Offline')); const user = userEvent.setup(); render(<Billing session="atlas" />);
  expect((await screen.findByRole('alert')).textContent).toBe('Offline');
  fixtures(); await user.click(screen.getByRole('button', { name: 'Refresh billing' }));
  await screen.findByText('Outstanding: 1.00 USD'); expect(screen.queryByRole('alert')).toBeNull();
});

test.each(['confirmed', 'rejected'])('operator reconciles pending payments as %s with a note', async decision => {
  const mock = fixtures(undefined, { ...state, invoices: [{ ...invoice, payments: [{ id: 'pay-1', amountUsd: '0.50', reference: 'BANK-001', status: 'pending' }] }] });
  const user = userEvent.setup(); render(<Billing session="operator" />);
  await user.selectOptions(await screen.findByLabelText('Decision'), decision);
  await user.type(screen.getByLabelText('Reconciliation note'), 'Matched statement');
  await user.click(screen.getByRole('button', { name: 'Reconcile payment' }));
  const post = mock.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(post[0]).toBe('/api/billing/payments/pay-1/reconcile');
  expect(JSON.parse(post[1]!.body as string)).toEqual({ decision, note: 'Matched statement' });
});

test('confirmed payment can only be reversed in the reconciliation form', async () => {
  fixtures(undefined, { ...state, invoices: [{ ...invoice, payments: [{ id: 'pay-1', amountUsd: '0.50', reference: 'BANK-001', status: 'confirmed' }] }] });
  render(<Billing session="operator" />);
  const decision = await screen.findByLabelText('Decision') as HTMLSelectElement;
  expect(Array.from(decision.options).map(o => o.value)).toEqual(['reversed']);
});
