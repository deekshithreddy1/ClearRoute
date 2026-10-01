import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected request: tests must provide an explicit fixture.'); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
