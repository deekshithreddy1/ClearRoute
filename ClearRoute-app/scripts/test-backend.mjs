import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { compile } from './check-types.mjs';

compile('tsconfig.backend.json', true);
// Discover from source so deleted tests cannot survive as stale build artifacts.
for (const file of readdirSync('backend').filter(name => name.endsWith('.test.ts')).sort()) {
  await import(pathToFileURL(path.resolve('dist-backend', file.replace(/\.ts$/, '.js'))).href);
}
