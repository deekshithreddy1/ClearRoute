import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import OperationsApp from '../../frontend/OperationsApp';
import { operationsState } from './operations-fixture';

const admin = { id: 'admin', name: 'Admin', role: 'operator' as const, tenantId: null };
const customer = { id: 'atlas-user', name: 'Atlas Labs', role: 'customer' as const, tenantId: 'atlas' };
test('admin sees separate financial metrics and three hosted networks without a LocalNet tab', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(operationsState));
  render(<OperationsApp identity={admin} />);
  await screen.findByText('Invoiced this month');
  expect(screen.getByText('Collected this month')).toBeTruthy();
  expect(screen.getByText('CC burned this month')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Monthly invoiced sales and collections' })).toBeTruthy();
  expect(screen.queryByText(/LocalNet/i)).toBeNull();
  expect([...screen.getByLabelText<HTMLSelectElement>('Network').options].map(o => o.value)).toEqual(['devnet', 'testnet', 'mainnet']);
  await userEvent.click(screen.getByRole('button', { name: 'Contracts' }));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Offer service' }).disabled).toBe(true);
});

test('customers have no treasury or policy controls and can submit funding requests with exact amounts', async () => {
  const calls: any[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => { if (init?.method === 'POST') { calls.push({ url, body: JSON.parse(String(init.body)) }); return Response.json({ id: 'request' }); } return Response.json({ ...operationsState, analytics: null }); });
  const user = userEvent.setup(); render(<OperationsApp identity={customer} />);
  await screen.findByRole('button', { name: 'View my service' });
  expect(screen.queryByRole('button', { name: 'Treasury planning' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Customers' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Funding requests' }));
  await user.selectOptions(screen.getByLabelText('Funding mode'), 'DirectTopUp');
  await user.type(screen.getByLabelText('Requested amount'), '1.0000000001');
  await user.type(screen.getByLabelText('Reason'), 'Fund batch');
  await user.click(screen.getByRole('button', { name: 'Submit funding request' }));
  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0].url).toBe('/api/operations/devnet/requests');
  expect(calls[0].body).toMatchObject({ mode: 'DirectTopUp', amount: '1.0000000001', reason: 'Fund batch' });
});

test('late data from one network never replaces the selected network', async () => {
  let resolveDev!: (response: Response) => void;
  vi.mocked(fetch).mockImplementation(async url => url === '/api/operations/devnet' ? new Promise(resolve => { resolveDev = resolve; }) : Response.json({ ...operationsState, network: 'testnet', accounts: [] }));
  render(<OperationsApp identity={admin} />);
  await userEvent.selectOptions(screen.getByLabelText('Network'), 'testnet');
  await screen.findByText('Invoiced this month');
  await act(async () => resolveDev(Response.json(operationsState)));
  await userEvent.click(screen.getByRole('button', { name: 'Customers' }));
  expect(await screen.findByText('Your first customer starts here')).toBeTruthy();
  expect(screen.queryByText('Atlas Labs')).toBeNull();
});

test('a retained command retries the same identifier and body after an uncertain HTTP failure', async () => {
  const body = { action: 'accept', contractId: 'offer-contract' };
  localStorage.setItem('operations.pending', JSON.stringify({ network: 'testnet', key: 'stable-key', body }));
  const submitted: RequestInit[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST') { submitted.push(init); return submitted.length === 1 ? Response.json({ error: { message: 'Connection unavailable' } }, { status: 503 }) : Response.json({ status: 'uncertain' }); }
    return Response.json({ ...operationsState, network: String(url).endsWith('testnet') ? 'testnet' : 'devnet', analytics: null });
  });
  render(<OperationsApp identity={customer} />);
  await screen.findByRole('button', { name: 'View my service' });
  await userEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await screen.findByText('Connection unavailable');
  expect(localStorage.getItem('operations.pending')).toContain('stable-key');
  await userEvent.click(screen.getByRole('button', { name: 'Retry same request' }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[0].body).toBe(submitted[1].body);
  expect((submitted[1].headers as any)['idempotency-key']).toBe('stable-key');
  await waitFor(() => expect(localStorage.getItem('operations.pending')).toBeNull());
});
