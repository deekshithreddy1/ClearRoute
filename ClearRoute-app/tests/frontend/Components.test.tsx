import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import Traffic from '../../frontend/Traffic';
import Metering from '../../frontend/Metering';
import Localnet from '../../frontend/Localnet';

const traffic = { target: { party: 'provider', domain: 'domain', minBytes: 200000, balanceCc: '10', checkedAt: '2026-09-01T00:00:00Z' }, maxBytes: 1000000, remainingLimitBytes: 1000000, purchases: [], error: null };
test('traffic capacity is operator-only and customer view makes no requests', () => {
  render(<Traffic session="atlas" />);
  expect(screen.queryByRole('button', { name: /Buy traffic/ })).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
test('traffic purchase rejects invalid quantities in the UI and retains uncertain request', async () => {
  const user = userEvent.setup();
  vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === 'POST' ? Response.json({ error: { message: 'Unknown result' } }, { status: 503 }) : Response.json(traffic));
  render(<Traffic session="operator" />);
  const input = await screen.findByLabelText('Traffic bytes');
  await user.clear(input); await user.type(input, '1');
  expect((screen.getByRole('button', { name: 'Buy traffic with test CC' }) as HTMLButtonElement).disabled).toBe(true);
  await user.clear(input); await user.type(input, '200000');
  await user.click(screen.getByRole('button', { name: 'Buy traffic with test CC' }));
  await screen.findByRole('alert');
  const saved = JSON.parse(localStorage.getItem('clearroute.traffic.pending')!);
  await user.click(screen.getByRole('button', { name: 'Check saved purchase' }));
  const posts = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect((posts[1][1]?.headers as Record<string, string>)['idempotency-key']).toBe(saved.key);
});
test('metering displays excluded unknown measurements without zero charges and hides customer writes', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ scope: 'Measured traffic', cursors: [], periods: {}, invoices: [], totals: [{ status: 'pending_measurement', bytes: null, count: 1 }], rows: [{ id: 'row-1', actor: 'atlas', action: 'Submit', bytes: null, status: 'pending_measurement', reason: 'Missing measurement', recordTime: '2026-09-01T00:00:00Z', offset: 1, chargeUsd: null }] }));
  render(<Metering session="atlas" />);
  await screen.findByText('Test charge: Excluded');
  expect(screen.queryByRole('button', { name: 'Refresh ledger measurements' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create test preview' })).toBeNull();
});
test('operator creates a preview for exactly the selected measured period', async () => {
  const user = userEvent.setup();
  vi.mocked(fetch).mockImplementation(async () => Response.json({ scope: '', cursors: [], periods: { atlas: ['2026-09-01T00:00:00Z'] }, invoices: [], totals: [], rows: [] }));
  render(<Metering session="operator" />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Create test preview' }) as HTMLButtonElement).disabled).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Create test preview' }));
  const call = vi.mocked(fetch).mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(call[0]).toBe('/api/metering/invoices');
  expect(JSON.parse(call[1]!.body as string)).toEqual({ tenantId: 'atlas', periodStart: '2026-09-01T00:00:00Z' });
});
test('ledger UI blocks a second workflow when reconciliation is required', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ connected: true, detail: 'Fixture connector', checkedAt: '2026-09-01T00:00:00Z', identities: { atlas: 'atlas::party' }, metering: '', runs: [{ id: 'run-1', tenant: 'atlas', status: 'needs_reconciliation', createdAt: '2026-09-01T00:00:00Z', steps: [] }] }));
  render(<Localnet session="atlas" tenantId="atlas" />);
  await screen.findByText('atlas::party');
  expect((screen.getByRole('button', { name: /Run ledger workflow/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});
