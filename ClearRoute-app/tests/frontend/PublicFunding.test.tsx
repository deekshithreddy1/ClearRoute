import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, expect, vi } from 'vitest';
import PublicFunding, { FundingReceipt, type FundingRecord } from '../../frontend/PublicFunding';
import DemoTransfers from '../../frontend/DemoTransfers';

const record: FundingRecord = { id: 'request-1', network: 'devnet', company: 'Team', email: 'user@example.com', party: 'receiver::1220' + 'a'.repeat(64), wallet: 'Splice', amount: '1.00', purpose: 'Testing funding', status: 'pending', note: '', trackingId: null, expiresAt: null, error: null, evidence: null, events: [{ at: '2026-10-08T12:00:00Z', kind: 'pending' }] };
beforeEach(() => { history.replaceState(null, '', '/funding'); sessionStorage.clear(); });
test('visitor submits without an account; duplicate retry uses same key and body after lost response', async () => {
  const submissions: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/requests')) {
      submissions.push(JSON.parse(String(init?.body)));
      if (submissions.length === 1) throw new Error('Connection lost');
      return { ok: true, json: async () => record };
    }
    if (url.endsWith('/track')) return { ok: true, json: async () => record };
    return { ok: true, json: async () => ({ maxRequestCc: '10', transfersEnabled: true }) };
  }));
  render(<PublicFunding />);
  await screen.findByRole('button', { name: 'Request CC' });
  fireEvent.change(screen.getByLabelText('Team / project'), { target: { value: 'Team' } });
  fireEvent.change(screen.getByLabelText('Contact email'), { target: { value: 'user@example.com' } });
  fireEvent.change(screen.getByLabelText('Full Canton Devnet Party ID'), { target: { value: record.party } });
  fireEvent.change(screen.getByLabelText('Wallet provider'), { target: { value: 'Splice' } });
  fireEvent.change(screen.getByLabelText('What are you testing?'), { target: { value: 'Testing funding' } });
  await userEvent.click(screen.getByLabelText(/My wallet is on Devnet/));
  await userEvent.click(screen.getByLabelText(/I control this recipient/));
  await userEvent.click(screen.getByRole('button', { name: 'Request CC' }));
  await screen.findByText('Connection lost');
  await userEvent.click(screen.getByRole('button', { name: 'Retry saved request' }));
  await screen.findByText('Keep your tracking link');
  expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(location.hash.slice(1)).toBe(submissions[0].key);
  expect(screen.queryByText('CC delivered')).toBeNull();
});
test('approved request is not delivery; created offer directs recipient to their wallet', () => {
  const rendered = render(<FundingReceipt record={{ ...record, status: 'approved' }} />);
  expect(screen.getByText('Approved — ready to send')).toBeTruthy();
  expect(screen.queryByText('CC delivered')).toBeNull();
  rendered.rerender(<FundingReceipt record={{ ...record, status: 'created' }} />);
  expect(screen.getByText(/Open your own wallet/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
});
test('operator cannot send a pending or uncertain request and must use reconciliation', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ transfersEnabled: true, maxRequestCc: '10', budgetCc: '100', reservedCc: '1.00', deliveredCc: '0.00', wallet: null, requests: [{ ...record, status: 'uncertain' }] }) }));
  vi.stubGlobal('fetch', fetcher); render(<DemoTransfers />);
  await screen.findByRole('button', { name: 'Reconcile original transfer' });
  expect(screen.queryByRole('button', { name: /Send .* CC offer/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Reconcile original transfer' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/devnet-funding/request-1/reconcile', expect.objectContaining({ method: 'POST', body: '{}' })));
});
