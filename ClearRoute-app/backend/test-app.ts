import { createApp } from './app.js';

// Existing fixture tests exercise the explicitly enabled demo surface.
// Authentication tests import createApp directly to cover its secure default.
export function createDemoApp(...args: Parameters<typeof createApp>) {
  args[6] = { mode: 'demo' };
  return createApp(...args);
}
