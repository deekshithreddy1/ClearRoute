import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { compile } from './check-types.mjs';

compile('tsconfig.server.json', true);
// Discover from source so deleted tests cannot survive as stale build artifacts.
for (const file of readdirSync('server').filter(name => name.endsWith('.test.ts')).sort()) {
  await import(pathToFileURL(path.resolve('dist-server', file.replace(/\.ts$/, '.js'))).href);
}
