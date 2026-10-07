import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ledger, type LocalConfig, type LocalIdentity } from './localnet-client.js';
import { AppError } from './money.js';

type Step = {name:string;updateId:string;contractId:string;recordTime:string;offset:number};
export class Localnet {
  private db: DatabaseSync;
  private running = new Set<string>();
  constructor(private directory: string, private call: typeof ledger = ledger, private configFile = path.join(directory, 'localnet.json')) {
    this.db = new DatabaseSync(path.join(directory,'localnet.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,createdAt TEXT NOT NULL,steps TEXT NOT NULL,error TEXT);
      UPDATE runs SET status='needs_reconciliation',error='Server restarted before the outcome was recorded. Do not resubmit.' WHERE status='submitting';`);
    if (!(this.db.prepare('PRAGMA table_info(runs)').all() as any[]).some(column=>column.name==='intent')) this.db.exec('ALTER TABLE runs ADD COLUMN intent TEXT');
  }
  close() { this.db.close(); }
  meteringCommands(){
    const commands=new Map<string,{tenant:string;actor:string;name:string;runId:string}>();
    for(const row of this.db.prepare('SELECT id,tenant FROM runs').all() as any[]){
      for(const name of ['Offer service','Customer accepts','Issue service allowance','Customer submits sample','Provider completes sample']){
        const actor=['Customer accepts','Customer submits sample'].includes(name)?row.tenant:'provider';
        commands.set(createHash('sha256').update(`${row.id}:${name}`).digest('hex'),{tenant:row.tenant,actor,name,runId:row.id});
      }
    }
    return commands;
  }
  private config(): LocalConfig {
    try { return JSON.parse(readFileSync(this.configFile,'utf8')); }
    catch { throw new AppError('LOCALNET_SETUP_REQUIRED','Run npm run localnet:setup from the application folder.',503); }
  }
  list(tenant?:string) {
    const rows = (tenant ? this.db.prepare('SELECT * FROM runs WHERE tenant=? ORDER BY createdAt DESC LIMIT 30').all(tenant) : this.db.prepare('SELECT * FROM runs ORDER BY createdAt DESC LIMIT 60').all()) as any[];
    return rows.map(row=>({...row,key:undefined,steps:JSON.parse(row.steps)}));
  }
  async state(tenant?:string) {
    let connected=false, detail=''; let identities: Record<string,string> = {};
    try {
      const config=this.config();
      for (const name of tenant ? [tenant] : ['provider','atlas','nova']) identities[name]=config[name as keyof LocalConfig].party;
      const result=await this.call(config.provider.user,'/v2/state/ledger-end');
      connected=typeof result.offset === 'number';
      detail=connected?'LocalNet Ledger API responded.':'Ledger response did not contain an offset.';
    } catch(error) { detail=error instanceof Error ? error.message : 'LocalNet unavailable'; }
    return {network:'LocalNet',connected,detail,checkedAt:new Date().toISOString(),identities,runs:this.list(tenant),metering:'Customer traffic is reconciled separately in Measured usage. Use Gas station for funded execution; this workspace shows direct test workflows.'};
  }
  async run(tenant:'atlas'|'nova', key:string) {
    if (!/^[\w-]{8,150}$/.test(key)) throw new AppError('IDEMPOTENCY_REQUIRED','A stable request ID is required.');
    const scoped=`${tenant}:${key}`;
    const prior=this.db.prepare('SELECT * FROM runs WHERE key=?').get(scoped) as any;
    if (prior) return {...prior,key:undefined,steps:JSON.parse(prior.steps)};
    if (this.running.has(tenant) || this.db.prepare("SELECT id FROM runs WHERE tenant=? AND status IN ('submitting','needs_reconciliation')").get(tenant))
      throw new AppError('LOCALNET_PENDING','This account has a pending or uncertain ledger operation. Reconcile it before starting another.',409);
    const config=this.config(); const provider=config.provider; const customer=config[tenant];
    const id=`ln-${randomUUID()}`; const createdAt=new Date().toISOString(); const steps:Step[]=[];
    this.db.prepare('INSERT INTO runs (id,tenant,key,status,createdAt,steps) VALUES (?,?,?,?,?,?)').run(id,tenant,scoped,'submitting',createdAt,'[]');
    this.running.add(tenant);
    const template=(name:string)=>`#clearroute:ClearRoute.Service:${name}`;
    const submit=async(name:string,actor:LocalIdentity,command:any,createdTemplate:string) => {
      const commandId=createHash('sha256').update(`${id}:${name}`).digest('hex');
      const request={
        commands:{commandId,actAs:[actor.party],commands:[command]},
      };
      this.db.prepare('UPDATE runs SET intent=? WHERE id=?').run(JSON.stringify({name,user:actor.user,request}),id);
      const result=await this.call(actor.user,'/v2/commands/submit-and-wait-for-transaction',request);
      const tx=result.transaction;
      const event=tx?.events?.map((e:any)=>e.CreatedEvent).find((e:any)=>e?.templateId?.endsWith(`:ClearRoute.Service:${createdTemplate}`));
      if (!tx?.updateId || !event?.contractId) throw new Error('Ledger returned an unexpected transaction. Manual reconciliation is required.');
      steps.push({name,updateId:tx.updateId,contractId:event.contractId,recordTime:tx.recordTime,offset:tx.offset});
      this.db.prepare('UPDATE runs SET steps=?,intent=NULL WHERE id=?').run(JSON.stringify(steps),id);
      return event.contractId;
    };
    const exercise=(name:string,cid:string,choice:string,choiceArgument:any)=>({ExerciseCommand:{templateId:template(name),contractId:cid,choice,choiceArgument}});
    try {
      const tomorrow=new Date(Date.now()+86400000).toISOString();
      const offer=await submit('Offer service',provider,{CreateCommand:{templateId:template('ServiceOffer'),createArguments:{provider:provider.party,customer:customer.party,agreementId:id,network:'LocalNet',mode:'ManagedUsage',terms:{termsRef:'localnet-test-only',pricingPolicyVersion:'unpriced-localnet-v1',exposureLimitUsd:'1.0',maxAllowanceUnits:'100',validUntil:tomorrow},acceptBefore:tomorrow}}},'ServiceOffer');
      const agreement=await submit('Customer accepts',customer,exercise('ServiceOffer',offer,'Accept',{}),'ServiceAgreement');
      const allowance=await submit('Issue service allowance',provider,exercise('ServiceAgreement',agreement,'IssueAllowance',{allowanceId:id,units:'100',allowanceExpiresAt:tomorrow}),'UsageAllowance');
      const job=await submit('Customer submits sample',customer,exercise('UsageAllowance',allowance,'SubmitDemoJob',{jobId:id}),'DemoJob');
      await submit('Provider completes sample',provider,exercise('DemoJob',job,'CompleteDemoJob',{resultRef:`localnet-sample:${id}`}),'DemoCompletion');
      this.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(id);
    } catch(error) {
      this.db.prepare("UPDATE runs SET status='needs_reconciliation',error=? WHERE id=?").run(error instanceof Error?error.message:'Unknown ledger result',id);
    } finally { this.running.delete(tenant); }
    return this.list(tenant).find(row=>row.id===id);
  }
}
