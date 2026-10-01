import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import App from '../../src/App';
import state from './fixtures/state.json';

function fixture() {
  return vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') return Response.json({ result: { id: 'request-1' } });
    const session = (options?.headers as Record<string, string>)?.['x-demo-session'];
    if (url === '/api/state') return Response.json({ ...state, tenants: state.tenants.map(t => ({ ...t, id: session, name: session === 'nova' ? 'Nova Markets' : 'Atlas Labs' })) });
    if (url === '/api/billing') return Response.json({ now: state.now, invoices: [], audit: [], lateUsage: [] });
    if (url === '/api/sponsorship') return Response.json({ policies: [], requests: [], audit: [] });
    if (url === '/api/metering') return Response.json({ scope: '', cursors: [], periods: {}, invoices: [], totals: [], rows: [] });
    if (url === '/api/localnet') return Response.json({ connected: false, detail: 'Offline fixture', checkedAt: state.now, runs: [], identities: {}, metering: '' });
    throw new Error(`Unexpected request: ${url}`);
  });
}

test('every workspace renders through navigation without a ledger connection', async () => {
  fixture(); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'A clear path to your next transaction.' });
  const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  for (const name of ['Gas station', 'Managed usage', 'CC Top-up', 'Activity', 'Invoices', 'Settings', 'Traffic purchases', 'Measured usage', 'Billing', 'LocalNet']) {
    await user.click(navigation.getByRole('button', { name }));
    expect(await screen.findByRole('heading', { level: 1, name })).toBeTruthy();
  }
});

test('funding dialog supports keyboard dismissal and sends the selected customer', async () => {
  const mock = fixture(); const user = userEvent.setup(); render(<App />);
  const start = await screen.findByRole('button', { name: 'Get started' });
  await user.click(start); await screen.findByRole('dialog'); await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(start);
  await user.click(start);
  await user.click(screen.getByRole('button', { name: 'Submit request' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const post = mock.mock.calls.find(([, options]) => options?.method === 'POST')!;
  expect(post[0]).toBe('/api/requests');
  expect(JSON.parse(post[1]!.body as string)).toEqual({ tenantId: 'atlas', mode: 'managed', limitUsd: '25.00' });
});

test('server errors preserve the main workflow request key for safe retry', async () => {
  const mock = fixture(); const base = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, options) => options?.method === 'POST' ? Response.json({ error: { message: 'Uncertain result' } }, { status: 503 }) : base(url, options));
  const user = userEvent.setup(); render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Get started' }));
  await user.click(screen.getByRole('button', { name: 'Submit request' }));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Retry safely' }) as HTMLButtonElement).disabled).toBe(false));
  const saved = JSON.parse(localStorage.getItem('launchfuel.pending')!);
  await user.click(screen.getByRole('button', { name: 'Retry safely' }));
  const posts = mock.mock.calls.filter(([, options]) => options?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect((posts[1][1]?.headers as Record<string, string>)['idempotency-key']).toBe(saved.key);
});

test('top-up requires explicit consent and an unexpired quote', async () => {
  fixture(); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('button', { name: 'Get started' });
  await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'CC Top-up' }));
  const submit = screen.getByRole('button', { name: 'Simulate CC top-up' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  await user.click(screen.getByRole('checkbox'));
  expect(submit.disabled).toBe(false);
});

test('switching customer requests new scoped state', async () => {
  const mock = fixture(); const user = userEvent.setup(); render(<App />);
  await screen.findByRole('button', { name: 'Get started' });
  await user.selectOptions(screen.getByLabelText('Local demo role'), 'nova');
  await screen.findByRole('heading', { name: 'Nova Markets' });
  expect(mock.mock.calls.some(([, options]) => (options?.headers as Record<string, string>)?.['x-demo-session'] === 'nova')).toBe(true);
  expect(localStorage.getItem('launchfuel.session')).toBe('nova');
});
