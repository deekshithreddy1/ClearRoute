import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const name = 'clearroute-smoke-' + randomUUID().slice(0, 8);
const volume = name + '-data';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let created = false;
const keepAlive = setInterval(() => {}, 1000);
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url + '/healthz', { signal: AbortSignal.timeout(2000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Container did not become healthy');
}
try {
  docker('run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--mount', 'type=volume,source=' + volume + ',target=/app/data', '-p', '127.0.0.1::3001', '-e', 'CLEARROUTE_NETWORK_MODE=offline', process.argv[2] || 'clearroute:verified');
  created = true;
  let url = 'http://' + docker('port', name, '3001/tcp').split('\n')[0];
  await ready(url);
  assert.match(await (await fetch(url)).text(), /ClearRoute/);
  assert.equal((await fetch(url + '/api/operations/devnet')).status, 401);
  docker('exec', name, 'node', 'dist-backend/auth-admin.js', 'create', '--id', 'smoke-admin', '--name', 'Smoke admin', '--role', 'operator');
  const issued = docker('exec', name, 'node', 'dist-backend/auth-admin.js', 'issue', '--id', 'smoke-admin', '--days', '1');
  const key = JSON.parse(issued.slice(issued.indexOf('{'))).token;
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ accessKey: key }) });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  const state = await fetch(url + '/api/operations/devnet', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).configured, false);
  docker('restart', name);
  url = 'http://' + docker('port', name, '3001/tcp').split('\n')[0];
  await ready(url);
  const after = await fetch(url + '/api/auth/session', { headers: { authorization: 'Bearer ' + key } });
  assert.equal((await after.json()).principal.id, 'smoke-admin');
  const report = { testedAt: new Date().toISOString(), image: docker('inspect', name, '--format', '{{.Image}}'), passed: ['frontend served', 'health endpoint', 'unauthenticated API rejected', 'login and HttpOnly cookie', 'operations API', 'persistent identity after restart'], nativeNetworkAccess: false };
  writeFileSync('container-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (created) console.error(docker('logs', '--tail', '30', name));
  throw error;
} finally {
  clearInterval(keepAlive);
  if (created) docker('rm', '-f', name);
  try { docker('volume', 'rm', volume); } catch {}
}
