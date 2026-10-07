import type { Express, Request } from 'express';
import { z } from 'zod';
import { AppError } from './money.js';
import type { Store } from './store.js';
import type { IdentityStore } from './auth.js';

export type AuthOptions = { mode?: 'required' | 'demo'; identities?: IdentityStore; origins?: string[]; secureCookies?: boolean; networkMode?: 'offline' | 'localnet' | 'devnet' | 'testnet' | 'mainnet' };
const cookieName = 'clearroute_session';
function cookie(req: Request) {
  const values = (req.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : '';
}

export function installAuth(app: Express, store: Store, options: AuthOptions) {
  const mode = options.mode || 'required';
  const origins = new Set(options.origins || ['http://127.0.0.1:3001', 'http://localhost:3001', 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: options.secureCookies ?? false, path: '/api' };
  const identities = () => { if (!options.identities) throw new AppError('AUTH_UNAVAILABLE', 'Identity service is not configured.', 503); return options.identities; };
  const readIdentity = (req: Request) => {
    const authorization = req.get('authorization');
    if (authorization !== undefined) {
      if (!/^Bearer crk_[A-Za-z0-9_-]{43}$/.test(authorization)) throw new AppError('UNAUTHORIZED', 'Invalid bearer credential.', 401);
      return identities().authenticateKey(authorization.slice(7));
    }
    return identities().authenticateSession(cookie(req));
  };
  const attempts = new Map<string, { count: number; until: number }>();
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if ((origin && !origins.has(origin)) || req.get('sec-fetch-site') === 'cross-site') return next(new AppError('ORIGIN_REJECTED', 'This website is not allowed to access ClearRoute.', 403));
    // Browser cookie mutations require an allowed Origin. Non-browser API
    // clients use Bearer credentials; GET requests never mutate account state.
    if (mode === 'required' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (cookie(req) || req.path === '/auth/login') && !req.get('authorization') && !origin) return next(new AppError('ORIGIN_REQUIRED', 'Browser requests must include an allowed Origin.', 403));
    next();
  });
  app.get('/api/auth/session', (req, res, next) => {
    if (mode === 'demo') return res.json({ mode, networkMode: options.networkMode || 'offline', principal: null });
    try { res.json({ mode, networkMode: options.networkMode || 'offline', principal: readIdentity(req) }); }
    catch (e) { if (e instanceof AppError && e.status === 401) return res.json({ mode, networkMode: options.networkMode || 'offline', principal: null }); next(e); }
  });
  app.post('/api/auth/login', (req, res, next) => {
    try {
      if (mode === 'demo') throw new AppError('DEMO_MODE', 'Access-key login is disabled in demo mode.', 409);
      const now = Date.now(), ip = req.ip || 'unknown';
      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const window = attempts.get(ip) || { count: 0, until: now + 60000 };
      if (window.count >= 10) { res.setHeader('Retry-After', String(Math.ceil((window.until - now) / 1000))); throw new AppError('RATE_LIMITED', 'Too many sign-in attempts. Try again shortly.', 429); }
      window.count++; attempts.set(ip, window);
      const { accessKey } = z.object({ accessKey: z.string().min(1).max(100) }).strict().parse(req.body);
      const result = identities().login(accessKey);
      if (cookie(req)) identities().logout(cookie(req));
      res.cookie(cookieName, result.session, { ...cookieOptions, expires: new Date(result.expiresAt) });
      res.json({ principal: result.principal, expiresAt: result.expiresAt });
    } catch (e) { next(e); }
  });
  app.post('/api/auth/logout', (req, res, next) => {
    try { if (mode !== 'demo') identities().logout(cookie(req)); res.clearCookie(cookieName, cookieOptions); res.status(204).end(); } catch (e) { next(e); }
  });
  app.use('/api', (req, res, next) => {
    try {
      // Caller-provided role/tenant headers have no authority in required mode.
      res.locals.session = mode === 'demo' ? store.session(req.get('x-demo-session')) : readIdentity(req);
      next();
    } catch (e) { next(e); }
  });
}
