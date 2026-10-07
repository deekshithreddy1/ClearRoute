import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, expect, vi } from 'vitest';
import AuthGate from '../../frontend/AuthGate';
import { AccountContext, useAccountStorage } from '../../frontend/account-storage';
import { operationsState as state } from './operations-fixture';

const principal = { id: 'atlas-owner', name: 'Atlas owner', role: 'customer', tenantId: 'atlas' };
test('sign-in gates application calls, locks role, and sign-out removes customer UI', async () => {
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (url === '/api/auth/session') return Response.json({ mode: 'required', networkMode: 'offline', principal: null });
    if (url === '/api/auth/login') { expect(JSON.parse(String(options?.body))).toEqual({ accessKey: 'test-key' }); return Response.json({ principal }); }
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    if (url === '/api/operations/devnet') return Response.json(state);
    throw new Error(`Unexpected call ${url}`);
  });
  render(<AuthGate />); const user = userEvent.setup();
  const input = await screen.findByLabelText('Access key');
  expect(fetch).toHaveBeenCalledTimes(1);
  await user.type(input, 'test-key'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByText('atlas · customer account');
  expect(screen.queryByLabelText('Local demo role')).toBeNull();
  expect(screen.getByText(/Canton connections disabled/)).toBeTruthy();
  expect(JSON.stringify(localStorage)).not.toContain('test-key');
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByLabelText('Access key'); expect(screen.queryByRole('navigation')).toBeNull();
});

test('identity outages fail closed and do not load demo state', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({}, { status: 503 }));
  render(<AuthGate />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByLabelText('Local demo role')).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});

test('invalid credentials clear the input and show the server error', async () => {
  vi.mocked(fetch).mockImplementation(async url => url === '/api/auth/session'
    ? Response.json({ mode: 'required', networkMode: 'offline', principal: null })
    : Response.json({ error: { message: 'Credential expired.' } }, { status: 401 }));
  const user = userEvent.setup(); render(<AuthGate />);
  const input = await screen.findByLabelText('Access key') as HTMLInputElement;
  await user.type(input, 'expired'); await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Credential expired.'); expect(input.value).toBe('');
});

test('unauthorized API responses remove authenticated content', async () => {
  vi.mocked(fetch).mockImplementation(async url => url === '/api/auth/session'
    ? Response.json({ mode: 'required', networkMode: 'offline', principal }) : Response.json(state));
  render(<AuthGate />); await screen.findByText('atlas · customer account');
  act(() => window.dispatchEvent(new Event('clearroute:unauthorized')));
  await screen.findByLabelText('Access key'); expect(screen.queryByRole('navigation')).toBeNull();
});

test('malformed login responses cannot open a demo or authenticated workspace', async () => {
  vi.mocked(fetch).mockImplementation(async url => url === '/api/auth/session'
    ? Response.json({ mode: 'required', networkMode: 'offline', principal: null })
    : Response.json({ principal: { role: 'operator' } }));
  const user = userEvent.setup(); render(<AuthGate />);
  await user.type(await screen.findByLabelText('Access key'), 'test-key');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('alert'); expect(screen.queryByRole('navigation')).toBeNull();
});

test('pending operations remain isolated when accounts change', async () => {
  function Pending() { const storage = useAccountStorage(); return <button onClick={() => storage.setItem('pending', 'operation')}>{storage.getItem('pending') || 'empty'}</button>; }
  const view = render(<AccountContext.Provider value="alice"><Pending /></AccountContext.Provider>);
  await userEvent.click(screen.getByRole('button')); view.rerender(<AccountContext.Provider value="bob"><Pending /></AccountContext.Provider>);
  expect(screen.getByRole('button').textContent).toBe('empty');
  view.rerender(<AccountContext.Provider value="alice"><Pending /></AccountContext.Provider>);
  await waitFor(() => expect(screen.getByRole('button').textContent).toBe('operation'));
});

test('a delayed session refresh cannot restore the UI after sign-out', async () => {
  let sessionCalls = 0;
  let resolveRefresh!: (response: Response) => void;
  const status = { mode: 'required', networkMode: 'offline', principal };
  vi.mocked(fetch).mockImplementation(async url => {
    if (url === '/api/auth/session') return ++sessionCalls === 1 ? Response.json(status) : new Promise<Response>(resolve => { resolveRefresh = resolve; });
    if (url === '/api/auth/logout') return new Response(null, { status: 204 });
    return Response.json(state);
  });
  render(<AuthGate />); await screen.findByText('atlas · customer account');
  act(() => window.dispatchEvent(new Event('focus')));
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await screen.findByLabelText('Access key');
  await act(async () => resolveRefresh(Response.json(status)));
  expect(screen.queryByRole('navigation')).toBeNull();
});
