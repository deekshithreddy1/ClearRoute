import type { Express } from 'express';
import { z } from 'zod';
import { networkName, tenantKey } from './networks.js';
import type { Operations } from './operations.js';
import { AppError } from './money.js';

export function installOperations(app: Express, ops?: Operations, allowDemo = false) {
  app.use('/api/operations', (_req, _res, next) => next(!ops ? new AppError('OPERATIONS_UNAVAILABLE', 'Operations service is not configured.', 503) : allowDemo ? new AppError('AUTH_REQUIRED', 'Operations requires authenticated accounts.', 403) : undefined));
  app.get('/api/operations/:network', (req, res, next) => { try { res.json(ops!.state(networkName.parse(req.params.network), res.locals.session)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/requests', (req, res, next) => { try { res.json(ops!.request(networkName.parse(req.params.network), res.locals.session, req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/requests/:id', (req, res, next) => { try { res.json(ops!.reviewRequest(networkName.parse(req.params.network), res.locals.session, z.string().uuid().parse(req.params.id), req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/check', async (req, res, next) => { try { z.object({}).strict().parse(req.body); res.json(await ops!.health(networkName.parse(req.params.network), res.locals.session)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/policies/:tenant', (req, res, next) => { try { res.json(ops!.policy(networkName.parse(req.params.network), tenantKey.parse(req.params.tenant), res.locals.session, req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/planner', (req, res, next) => { try { res.json(ops!.planner(networkName.parse(req.params.network), res.locals.session, req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/treasury', (req, res, next) => { try { res.json(ops!.treasury(networkName.parse(req.params.network), res.locals.session, req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/commands', async (req, res, next) => { try { res.json(await ops!.submit(networkName.parse(req.params.network), res.locals.session, req.get('idempotency-key') ?? '', req.body)); } catch (e) { next(e); } });
  app.post('/api/operations/:network/reconcile', async (req, res, next) => { try { const b = z.object({ updateId: z.string().min(1).max(300), commandId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(req.body); res.json(await ops!.reconcile(networkName.parse(req.params.network), res.locals.session, b.updateId, b.commandId)); } catch (e) { next(e); } });
}
