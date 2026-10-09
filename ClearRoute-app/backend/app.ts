import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { Store, type Session } from './store.js';
import { AppError } from './money.js';
import type { Localnet } from './localnet.js';
import type { Traffic } from './traffic.js';
import type { Metering } from './metering.js';
import { policyInput, type Sponsorship } from './sponsorship.js';
import { installAuth, type AuthOptions } from './auth-http.js';
import type { OnboardingStore } from './onboarding.js';
import type { WalletFunding } from './wallet-funding.js';
import type { Operations } from './operations.js';
import { installOperations } from './operations-http.js';
import type { PublicFunding } from './public-funding.js';
import { publicFundingRoutes, operatorFundingRoutes } from './public-funding-http.js';

export function createApp(store: Store, staticPath?: string, localnet?: Localnet, traffic?: Traffic, metering?: Metering, sponsorship?: Sponsorship, auth: AuthOptions = {}, onboarding?: OnboardingStore, walletFunding?: WalletFunding, operations?: Operations, publicFunding?: PublicFunding) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (auth.secureCookies) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
  });
  app.use(express.json({ limit: '24kb' }));
  app.get('/healthz', (_req, res) => res.setHeader('Cache-Control', 'no-store').status(200).json({ service: 'clearroute', status: 'ok' }));
  app.get('/api/public-price', async (_req, res) => {
    try {
      let quote: { usd: number; usd_24h_change: number | null } | undefined;
      let source = 'ClearRoute public price proxy';
      try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=canton-coin,canton-network&vs_currencies=usd&include_24hr_change=true', { headers: { accept: 'application/json', ...(process.env.CLEARROUTE_COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.CLEARROUTE_COINGECKO_API_KEY } : {}) }, signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const raw = await response.json() as Record<string, { usd?: number; usd_24h_change?: number }>;
          const item = raw['canton-coin'] || raw['canton-network'];
          if (item?.usd && Number.isFinite(item.usd)) quote = { usd: item.usd, usd_24h_change: Number.isFinite(item.usd_24h_change) ? item.usd_24h_change! : null };
        }
      } catch { /* fall through to CantonScan */ }
      if (!quote) {
        try {
          const response = await fetch('https://pricing.noves.fi/daml/canton/price/cc', { headers: { accept: 'application/json', apiKey: process.env.CLEARROUTE_NOVES_API_KEY || 'demokey' }, signal: AbortSignal.timeout(8000) });
          if (response.ok) {
            const body = await response.text();
            let raw: { price?: number | string; usd?: number | string; data?: { price?: number | string } } = {};
            try { raw = JSON.parse(body) as typeof raw; } catch { /* Noves also documents text/plain responses */ }
            const value = raw.price ?? raw.usd ?? raw.data?.price ?? body.trim();
            const usd = typeof value === 'string' ? Number(value) : value;
            if (usd && Number.isFinite(usd)) { quote = { usd, usd_24h_change: null }; source = 'Noves Canton public price API'; }
          }
        } catch { /* fall through to explorer */ }
      }
      if (!quote) {
        const response = await fetch('https://www.cantonscan.com/', { headers: { accept: 'text/html', 'user-agent': 'ClearRoute/1.0' }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('CantonScan unavailable');
        const html = await response.text();
        const match = html.match(/\$(\d+(?:\.\d{1,8})?)[\s\S]{0,180}?USD per CC/i);
        if (!match) throw new Error('CantonScan returned no CC price');
        quote = { usd: Number(match[1]), usd_24h_change: null };
        source = 'CantonScan public explorer';
      }
      res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return res.json({ 'canton-coin': quote, source, checkedAt: new Date().toISOString() });
    } catch { return res.status(503).json({ error: { code: 'PRICE_UNAVAILABLE', message: 'The public CC price feed is temporarily unavailable.' } }); }
  });
  const devnetFunding = auth.networkMode === 'devnet' && auth.mode !== 'demo' ? publicFunding : undefined;
  installAuth(app, store, auth, () => publicFundingRoutes(app, devnetFunding, auth.origins ?? ['http://127.0.0.1:3001', 'http://localhost:3001', 'http://127.0.0.1:5173', 'http://localhost:5173']));
  operatorFundingRoutes(app, devnetFunding);
  installOperations(app, operations, auth.mode === 'demo');
  // Hosted deployments must never expose fixture financial mutations or the old
  // loopback connectors, even to an authenticated operator.
  if (auth.networkMode && ['devnet', 'testnet', 'mainnet'].includes(auth.networkMode)) app.use('/api', (_req, _res, next) => next(new AppError('LEGACY_API_DISABLED', 'This deployment uses the network operations API.', 410)));
  app.use('/api/wallet-funding', (_req,_res,next) => next(walletFunding ? undefined : new AppError('WALLET_UNAVAILABLE','Native wallet funding requires LocalNet mode.',503)));
  app.get('/api/wallet-funding', async (_req,res,next) => { try { res.json(await walletFunding!.state(res.locals.session.tenantId || undefined)); } catch(e) { next(e); } });
  app.post('/api/wallet-funding', async (req,res,next) => { try {
    store.operator(res.locals.session);
    const body = z.object({tenantId:z.enum(['atlas','nova']),amountCc:z.string().min(1).max(40),recipientPartyId:z.string().min(10).max(300).optional()}).strict().parse(req.body);
    res.json({result:await walletFunding!.offer(body.tenantId,body.amountCc,req.get('idempotency-key') || '',body.recipientPartyId)});
  } catch(e) { next(e); } });
  app.post('/api/wallet-funding/:id/accept', async (req,res,next) => { try {
    z.object({}).strict().parse(req.body);
    if (!res.locals.session.tenantId) throw new AppError('CUSTOMER_CONSENT_REQUIRED','Sign in as the recipient to accept this transfer.',403);
    res.json({result:await walletFunding!.accept(String(req.params.id),res.locals.session.tenantId)});
  } catch(e) { next(e); } });
  app.post('/api/wallet-funding/:id/reconcile', async (req,res,next) => { try {
    z.object({}).strict().parse(req.body);
    const id=String(req.params.id),tenant=res.locals.session.tenantId || undefined;
    walletFunding!.get(id,tenant); await walletFunding!.reconcile(id); res.json({result:walletFunding!.get(id,tenant)});
  } catch(e) { next(e); } });
  app.use('/api/onboarding', (_req,_res,next) => next(onboarding ? undefined : new AppError('ONBOARDING_UNAVAILABLE','Onboarding registry is unavailable.',503)));
  app.get('/api/onboarding', (_req,res) => res.json(onboarding!.state(res.locals.session)));
  app.post('/api/onboarding/applications', (req,res,next) => { try { res.status(201).json(onboarding!.registerApplication(res.locals.session,req.body)); } catch(e){next(e);} });
  app.post('/api/onboarding/validators', (req,res,next) => { try { res.status(201).json(onboarding!.registerValidator(res.locals.session,req.body)); } catch(e){next(e);} });
  app.post('/api/onboarding/applications/:id/approve', (req,res,next) => { try { z.object({}).strict().parse(req.body); res.json(onboarding!.approveApplication(res.locals.session,String(req.params.id))); } catch(e){next(e);} });
  app.post('/api/onboarding/validators/:id/approve', (req,res,next) => { try { z.object({}).strict().parse(req.body); res.json(onboarding!.approveValidator(res.locals.session,String(req.params.id))); } catch(e){next(e);} });
  app.post('/api/onboarding/applications/:id/bind-validator', (req,res,next) => { try { const body=z.object({validatorId:z.string().min(3).max(64)}).strict().parse(req.body); res.json(onboarding!.bind(res.locals.session,String(req.params.id),body.validatorId)); } catch(e){next(e);} });
  app.get('/api/state', (_req, res) => res.json(store.state(res.locals.session)));
  app.use('/api/sponsorship', (_req, _res, next) => next(sponsorship ? undefined : new AppError('SPONSORSHIP_UNAVAILABLE', 'Gas station service is unavailable.', 503)));
  app.get('/api/sponsorship', (_req, res) => res.json(sponsorship!.state(res.locals.session.tenantId || undefined)));
  app.post('/api/sponsorship/policies/:tenant', async (req, res, next) => {
    try { store.operator(res.locals.session); const tenant = z.enum(['atlas','nova']).parse(req.params.tenant); res.json(await sponsorship!.approve(tenant, policyInput.parse(req.body))); } catch (e) { next(e); }
  });
  app.post('/api/sponsorship/requests', async (req, res, next) => {
    try { const body = z.object({tenantId:z.enum(['atlas','nova'])}).strict().parse(req.body); store.authorize(res.locals.session,body.tenantId); res.json({result:await sponsorship!.submit(body.tenantId,req.get('idempotency-key') || '')}); } catch (e) { next(e); }
  });
  app.post('/api/sponsorship/requests/:id/reconcile', async (req, res, next) => {
    try { z.object({}).strict().parse(req.body); const id=String(req.params.id); sponsorship!.get(id,res.locals.session.tenantId || undefined); await sponsorship!.reconcile(id); res.json({result:sponsorship!.get(id,res.locals.session.tenantId || undefined)}); } catch (e) { next(e); }
  });
  app.use('/api/metering',(_req,_res,next)=>next(metering?undefined:new AppError('METERING_DISABLED','Metering unavailable.',503)));
  app.get('/api/metering',(_req,res)=>res.json(metering!.state(res.locals.session.tenantId||undefined)));
  app.use('/api/billing',(_req,_res,next)=>next(metering?undefined:new AppError('BILLING_DISABLED','Billing unavailable.',503)));
  app.get('/api/billing',(_req,res)=>res.json(metering!.billing.state(res.locals.session.tenantId||undefined)));
  function billingPost<T extends z.ZodTypeAny>(route:string,schema:T,run:(body:z.infer<T>,req:Request)=>unknown){
    app.post(route,(req,res,next)=>{try{store.operator(res.locals.session);const body=schema.parse(req.body);res.json(metering!.billing.mutate(req.get('idempotency-key')||'',req.path,body,()=>run(body,req)));}catch(e){next(e);}});
  }
  billingPost('/api/billing/clock/advance',z.object({days:z.literal(15)}).strict(),()=>metering!.billing.advance());
  billingPost('/api/billing/finalize',z.object({tenantId:z.enum(['atlas','nova']),periodStart:z.string().datetime(),previewId:z.string().min(1).max(100)}).strict(),b=>metering!.finalize(b.tenantId,b.periodStart,b.previewId));
  billingPost('/api/billing/invoices/:id/payments',z.object({amountUsd:z.string().min(1).max(40),reference:z.string().min(4).max(120),rail:z.literal('sandbox_usd')}).strict(),(b,r)=>metering!.billing.payment(String(r.params.id),b.amountUsd,b.reference));
  billingPost('/api/billing/payments/:id/reconcile',z.object({decision:z.enum(['confirmed','rejected','reversed']),note:z.string().trim().min(1).max(240)}).strict(),(b,r)=>metering!.billing.decide(String(r.params.id),b.decision,b.note));
  app.get('/api/billing/invoices/:id/export',(req,res,next)=>{try{const invoice=metering!.billing.state(res.locals.session.tenantId||undefined).invoices.find(i=>i.id===req.params.id);if(!invoice)throw new AppError('NOT_FOUND','Invoice not found.',404);res.setHeader('Content-Disposition',`attachment; filename="${invoice.id}.json"`);res.json(invoice);}catch(e){next(e);}});
  app.post('/api/metering/sync',async(req,res,next)=>{try{store.operator(res.locals.session);z.object({}).strict().parse(req.body);await metering!.sync();res.json(metering!.state());}catch(e){next(e);}});
  app.post('/api/metering/invoices',(req,res,next)=>{try{store.operator(res.locals.session);const b=z.object({tenantId:z.enum(['atlas','nova']),periodStart:z.string().datetime()}).strict().parse(req.body);if(!metering!.state(b.tenantId).periods[b.tenantId]?.includes(b.periodStart))throw new AppError('INVALID_PERIOD','Select a measured fifteen-day period.');res.json(metering!.invoice(b.tenantId,Date.parse(b.periodStart)));}catch(e){next(e);}});
  app.use('/api/traffic',(_req,res,next)=>{
    try{store.operator(res.locals.session);if(!traffic)throw new AppError('TRAFFIC_DISABLED','Traffic connector unavailable.',503);next();}catch(e){next(e);}
  });
  app.get('/api/traffic',async(_req,res,next)=>{try{res.json(await traffic!.state());}catch(e){next(e);}});
  app.post('/api/traffic',async(req,res,next)=>{
    try{const body=z.object({bytes:z.number().int().positive().max(1_000_000)}).strict().parse(req.body);res.json({result:await traffic!.purchase(body.bytes,req.get('idempotency-key')||'')});}catch(e){next(e);}
  });
  app.post('/api/traffic/:id/reconcile',async(req,res,next)=>{
    try{z.object({}).strict().parse(req.body);await traffic!.reconcile(String(req.params.id));res.json(await traffic!.state());}catch(e){next(e);}
  });
  app.get('/api/localnet', async (_req,res,next)=>{
    try {
      if (!localnet) throw new AppError('LOCALNET_DISABLED','LocalNet connector is not configured.',503);
      res.json(await localnet.state(res.locals.session.tenantId || undefined));
    } catch(error) { next(error); }
  });
  app.post('/api/localnet/runs', async (req,res,next)=>{
    try {
      if (!localnet) throw new AppError('LOCALNET_DISABLED','LocalNet connector is not configured.',503);
      const body=z.object({tenantId:z.enum(['atlas','nova'])}).strict().parse(req.body);
      store.authorize(res.locals.session,body.tenantId);
      res.json({result:await localnet.run(body.tenantId,req.get('idempotency-key') || '')});
    } catch(error) { next(error); }
  });
  const tenantId = z.enum(['atlas', 'nova']);
  const money = z.string().min(1).max(40);
  const bytes = z.number().int().min(1).max(1_000_000);
  function post<T extends z.ZodTypeAny>(route: string, schema: T, fn: (s: Session, value: z.infer<T>, req: Request) => any) {
    app.post(route, (req, res, next) => {
      try {
        const value = schema.parse(req.body);
        const result = store.mutation(res.locals.session, req.get('idempotency-key') ?? '', req.path, value, () => fn(res.locals.session, value, req));
        res.json({ result });
      } catch (e) { next(e); }
    });
  }
  post('/api/requests', z.object({ tenantId, mode:z.literal('managed'), limitUsd:money }).strict(), (s,b)=>store.request(s,b));
  post('/api/requests/:id/approve', z.object({limitUsd:money}).strict(), (s,b,r)=>store.approve(s,String(r.params.id),b.limitUsd));
  post('/api/usage', z.object({tenantId,description:z.string().trim().min(1).max(160),trafficBytes:bytes}).strict(), (s,b)=>store.usage(s,b));
  post('/api/topups', z.object({tenantId,ccAmount:money,quoteId:z.string().min(1).max(100)}).strict(), (s,b)=>store.topup(s,b));
  post('/api/invoices/close', z.object({tenantId}).strict(), (s,b)=>store.closePeriod(s,b.tenantId));
  post('/api/invoices/:id/payments', z.object({amountUsd:money,rail:z.enum(['USD','USDC']),reference:z.string().trim().min(4).max(120)}).strict(), (s,b,r)=>store.payment(s,String(r.params.id),b));
  post('/api/clock/advance', z.object({days:z.literal(15)}).strict(), (s,b)=>{
    store.operator(s); store.setMeta('clock',String(store.now()+b.days*86_400_000));
    store.event('clock.advanced','Demo clock advanced 15 days. This is not real customer history.');
    return {now:new Date(store.now()).toISOString()};
  });
  post('/api/treasury/fund', z.object({trafficBytes:bytes}).strict(), (s,b)=>{store.operator(s); return store.fund(b.trafficBytes);});
  app.get('/api/invoices/:id/csv', (req,res,next)=>{
    try {
      const state = store.state(res.locals.session);
      const invoice = state.invoices.find(i=>i.id===req.params.id);
      if (!invoice) throw new AppError('NOT_FOUND','Invoice not found.',404);
      const safe = (v:string) => `"${(/^[=+@-]/.test(v)?"'":"")+v.replaceAll('"','""')}"`;
      const rows = [['Invoice','Description','Amount USD','Reference'],...invoice.lines.map(l=>[invoice.id,l.description,l.amountUsd,l.reference])];
      res.type('text/csv').setHeader('Content-Disposition',`attachment; filename="${invoice.id}-DEMO.csv"`);
      res.send(rows.map(row=>row.map(safe).join(',')).join('\r\n'));
    } catch(e) { next(e); }
  });
  app.use('/api', (_req,_res,next)=>next(new AppError('NOT_FOUND','API route not found.',404)));
  if (staticPath) {
    app.use(express.static(staticPath));
    app.get('/{*path}',(_req,res)=>res.sendFile(path.join(staticPath,'index.html')));
  }
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    res.setHeader('Cache-Control', 'no-store');
    if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({error:{code:'PAYLOAD_TOO_LARGE',message:'The request body exceeds the 24 KB limit.'}});
    if (error instanceof ZodError) return res.status(400).json({error:{code:'INVALID_INPUT',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}});
    if (error instanceof AppError) return res.status(error.status).json({error:{code:error.code,message:error.message}});
    if (error instanceof SyntaxError) return res.status(400).json({error:{code:'INVALID_JSON',message:'The request body must be valid JSON.'}});
    console.error('Unexpected application error',error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({error:{code:'INTERNAL_ERROR',message:'The result could not be verified. Retry with the same request identifier.'}});
  });
  return app;
}
