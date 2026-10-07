import { apiFetch } from './http';
import type { Session } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(session: Session, path: string, options: { body?: unknown; key?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await apiFetch(path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { 'x-demo-session': session, 'content-type': 'application/json', ...(options.key ? { 'idempotency-key': options.key } : {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal ?? AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error?.message || `Request failed (${response.status}).`, response.status);
  return data as T;
}
