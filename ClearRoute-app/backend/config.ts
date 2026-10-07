import path from 'node:path';
import { z } from 'zod';

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.CLEARROUTE_MODE && !['demo', 'hosted'].includes(env.CLEARROUTE_MODE)) throw new Error('Unknown application mode.');
  const mode = z.enum(['required', 'demo']).parse(env.CLEARROUTE_AUTH_MODE ?? 'required');
  const networkMode = z.enum(['offline', 'localnet', 'devnet', 'testnet', 'mainnet']).parse(env.CLEARROUTE_NETWORK_MODE ?? 'offline');
  const port = z.coerce.number().int().min(1024).max(65535).parse(env.PORT ?? 3001);
  const host = z.enum(['127.0.0.1', '0.0.0.0']).parse(env.CLEARROUTE_BIND_HOST ?? '127.0.0.1');
  const dataDir = path.resolve(env.CLEARROUTE_DATA_DIR ?? 'data');
  const localnetConfig = path.resolve(env.CLEARROUTE_LOCALNET_CONFIG ?? path.join(dataDir, 'localnet.json'));
  const hosted = ['devnet', 'testnet', 'mainnet'].includes(networkMode);
  const origins = env.CLEARROUTE_PUBLIC_ORIGIN ? [z.string().url().parse(env.CLEARROUTE_PUBLIC_ORIGIN)] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173'];
  if (hosted && (mode !== 'required' || !env.CLEARROUTE_PUBLIC_ORIGIN?.startsWith('https://') || new URL(env.CLEARROUTE_PUBLIC_ORIGIN).origin !== env.CLEARROUTE_PUBLIC_ORIGIN)) throw new Error('Hosted networks require authentication and an exact HTTPS CLEARROUTE_PUBLIC_ORIGIN.');
  return { mode, networkMode, port, host, dataDir, localnetConfig, hosted, secureCookies: hosted, profilesFile: env.CLEARROUTE_NETWORKS_FILE, origins };
}
