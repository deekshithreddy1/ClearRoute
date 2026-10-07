import { compile } from './check-types.mjs';
import { build } from 'vite';

compile('tsconfig.backend.json', true);
compile('tsconfig.json');
await build();
console.log('Built the TypeScript backend and Vite frontend.');
