import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('offline process starts and stops without connector databases or outbound requests', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'clearroute-offline-'));
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const address = probe.address(); if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    globalThis.fetch = async () => { process.stderr.write('UNEXPECTED_OUTBOUND_REQUEST'); process.exit(82); };
    await import('./dist-backend/index.js');
    setTimeout(() => process.emit('SIGTERM'), 5200);
  `], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, PORT: String(address.port), CLEARROUTE_DATA_DIR: directory, CLEARROUTE_MODE: 'demo', CLEARROUTE_AUTH_MODE: 'required', CLEARROUTE_NETWORK_MODE: 'offline' } });
  let output = '';
  child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); }
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(resolved, { recursive: true, force: true });
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, output); assert.match(output, /authentication=required; network=offline/);
  assert.ok(!output.includes('UNEXPECTED_OUTBOUND_REQUEST'));
  assert.deepEqual(readdirSync(directory).sort(), ['clearroute.sqlite', 'identities.sqlite', 'onboarding.sqlite', 'operations.sqlite']);
});
