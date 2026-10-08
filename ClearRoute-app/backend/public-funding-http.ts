import type { Express } from 'express';
import { z } from 'zod';
import { AppError } from './money.js';
import type { PublicFunding } from './public-funding.js';

export function publicFundingRoutes(app: Express, funding: PublicFunding | undefined, origins: string[]) {
  app.use('/api/public-funding', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!funding) throw new AppError('INTAKE_DISABLED', 'Public Devnet funding is not enabled on this server.', 503);
      if (req.method !== 'GET' && !origins.includes(req.get('origin') ?? '')) throw new AppError('ORIGIN_REQUIRED', 'Open the ClearRoute website to submit or track a request.', 403);
      funding.rate(req.ip ?? 'unknown', req.path === '/requests' ? 'intake' : 'read', req.path === '/requests' ? 5 : 120);
      next();
    } catch(e) { next(e); }
  });
  app.get('/api/public-funding', (_req, res) => res.json(funding!.info()));
  app.post('/api/public-funding/requests', (req, res, next) => { try { res.status(201).json(funding!.request(req.body)); } catch(e) { next(e); } });
  app.post('/api/public-funding/track', (req, res, next) => { try { res.json(funding!.track(req.body)); } catch(e) { next(e); } });
}
export function operatorFundingRoutes(app: Express, funding?: PublicFunding) {
  app.use('/api/devnet-funding', (_req, res, next) => next(res.locals.session?.role !== 'operator' ? new AppError('FORBIDDEN', 'Operator access required.', 403) : !funding ? new AppError('INTAKE_DISABLED', 'Enable public Devnet funding on the server.', 503) : undefined));
  app.get('/api/devnet-funding', (_req, res, next) => { try { res.json(funding!.state(res.locals.session)); } catch(e) { next(e); } });
  app.post('/api/devnet-funding/check', async (req, res, next) => { try { z.object({}).strict().parse(req.body); res.json(await funding!.check(res.locals.session)); } catch(e) { next(e); } });
  app.post('/api/devnet-funding/:id/:action', async (req, res, next) => {
    try {
      const id = z.string().uuid().parse(req.params.id), actor = res.locals.session;
      switch(req.params.action) {
        case 'review': return res.json(funding!.review(actor, id, req.body));
        case 'send': z.object({}).strict().parse(req.body); return res.json(await funding!.send(actor, id));
        case 'reconcile': z.object({}).strict().parse(req.body); return res.json(await funding!.reconcile(actor, id));
        default: throw new AppError('NOT_FOUND', 'Unknown funding action.', 404);
      }
    } catch(e) { next(e); }
  });
}
