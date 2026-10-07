import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ledger, type LocalConfig } from './localnet-client.js';
import type { Localnet } from './localnet.js';
import { AppError, format } from './money.js';
import { Billing } from './billing.js';

export const BILLING_PERIOD=15*86400000;
// This is explicitly a local demonstration tariff, not an agreed commercial policy.
export const TEST_POLICY={id:'measured-fixture-v1',usdPerCc:'0.20',ccEquivalentPerByte:'0.00002',microUsdPerByte:'4',source:'Static fixture captured at attribution, not a market quote or submission-time price',feeUsd:'0'};
const integer=z.number().int().nonnegative().safe();
const completionSchema=z.object({commandId:z.string().min(1),userId:z.string().min(1),actAs:z.array(z.string()),offset:integer,paidTrafficCost:integer.nullish(),updateId:z.string().nullable().optional(),status:z.object({code:z.number().int()}),synchronizerTime:z.object({synchronizerId:z.string().min(1),recordTime:z.string().datetime({offset:true})})}).passthrough();
export type Completion=z.infer<typeof completionSchema>;
export function parseCompletion(raw:unknown){return completionSchema.parse(raw);}
export function testCharge(bytes:number){integer.parse(bytes);return format(BigInt(bytes)*4n,6);}
export function periodFor(time:number,anchor:number){return anchor+Math.floor((time-anchor)/BILLING_PERIOD)*BILLING_PERIOD;}
type Commands=ReturnType<Localnet['meteringCommands']>;
export class Metering{
  private db:DatabaseSync;private syncing=false;
  readonly billing:Billing;
  constructor(private directory:string,private commands:()=>Commands,private call:typeof ledger=ledger,private configFile=path.join(directory,'localnet.json')){
    this.db=new DatabaseSync(path.join(directory,'metering.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS cursors(actor TEXT PRIMARY KEY,party TEXT NOT NULL,user TEXT NOT NULL,offset INTEGER NOT NULL,error TEXT,checkedAt TEXT);
      CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,actor TEXT NOT NULL,tenant TEXT,party TEXT NOT NULL,user TEXT NOT NULL,commandId TEXT NOT NULL,offset INTEGER NOT NULL,updateId TEXT,domain TEXT NOT NULL,recordTime TEXT NOT NULL,observedAt TEXT NOT NULL,bytes INTEGER,status TEXT NOT NULL,action TEXT NOT NULL,raw TEXT NOT NULL,transactionEvidence TEXT,reason TEXT,policy TEXT NOT NULL,amountMicro TEXT);
      CREATE TABLE IF NOT EXISTS test_invoices(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,periodStart TEXT NOT NULL,periodEnd TEXT NOT NULL,createdAt TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS anchors(actor TEXT PRIMARY KEY,anchor INTEGER NOT NULL);
    `);
    this.billing=new Billing(this.db);
  }
  close(){this.db.close();}
  measurementForRun(run:{steps:{name:string;updateId:string}[]}){
    const expected=run.steps.filter(s=>['Customer accepts','Customer submits sample'].includes(s.name));
    const rows=expected.map(step=>this.db.prepare("SELECT * FROM usage WHERE updateId=? AND status='verified'").get(step.updateId) as any);
    const complete=expected.length===2&&rows.every(Boolean);
    return {complete,bytes:complete?rows.reduce((sum,row)=>sum+row.bytes,0):0,chargeUsd:complete?format(rows.reduce((sum:bigint,row)=>sum+BigInt(row.amountMicro),0n),6):'0.00',updateIds:complete?expected.map(s=>s.updateId):[]};
  }
  finalize(tenant:'atlas'|'nova',periodStart:string,previewId:string){
    if(this.syncing)throw new AppError('SYNC_ACTIVE','Ledger synchronization is running. Retry finalization after it completes.',409);
    if(!this.state(tenant).periods[tenant]?.includes(periodStart))throw new AppError('INVALID_PERIOD','Select a measured billing period.');
    const cursor=this.db.prepare('SELECT error FROM cursors WHERE actor=?').get(tenant) as any;
    if(!cursor||cursor.error)throw new AppError('METERING_UNAVAILABLE','Resolve metering errors before finalizing.');
    const start=Date.parse(periodStart),end=start+BILLING_PERIOD;
    const pending=this.db.prepare("SELECT recordTime FROM usage WHERE actor=? AND status IN ('pending_measurement','pending_evidence')").all(tenant) as any[];
    if(pending.some(r=>Date.parse(r.recordTime)>=start&&Date.parse(r.recordTime)<end))throw new AppError('PENDING_EVIDENCE','This period still has unresolved measurements.');
    const preview=this.invoice(tenant,start);
    if(preview.id!==previewId)throw new AppError('STALE_PREVIEW','Measurements changed. Review the latest preview before finalizing.',409);
    return this.billing.finalize(preview);
  }
  private config():LocalConfig{return JSON.parse(readFileSync(this.configFile,'utf8'));}
  private view(row:any){return {...row,raw:undefined,transactionEvidence:undefined,policy:JSON.parse(row.policy),chargeUsd:row.amountMicro===null?null:format(row.amountMicro,6)};}
  private async prepare(raw:unknown,actor:string,identity:{user:string;party:string},commands:Commands){
    const c=parseCompletion(raw);
    if(c.userId!==identity.user||c.actAs.length!==1||c.actAs[0]!==identity.party)throw new Error('Unsupported completion identity or multi-party submission; ingestion stopped.');
    const known=commands.get(c.commandId),matches=known?.actor===actor;
    let status='unsupported',reason='Completion is outside the supported application submission journal.',transactionEvidence:any=null;
    if(matches){
      if(c.paidTrafficCost==null){status='pending_measurement';reason='Canton did not supply paidTrafficCost. No charge calculated.';}
      else if(c.status.code!==0){status='failed_pending_policy';reason='Failed submission traffic retained; excluded from billing until failure policy is agreed.';}
      else if(!c.updateId){status='pending_evidence';reason='Successful completion has no transaction reference.';}
      else try{
        const evidence=await this.call(identity.user,'/v2/updates/transaction-by-id',{updateId:c.updateId,requestingParties:[identity.party]});
        const tx=evidence.transaction;
        if(tx?.commandId!==c.commandId||tx?.updateId!==c.updateId||tx?.offset!==c.offset||tx?.paidTrafficCost!==c.paidTrafficCost||tx?.synchronizerId!==c.synchronizerTime.synchronizerId||tx?.recordTime!==c.synchronizerTime.recordTime)throw new Error('Completion and transaction evidence do not match.');
        transactionEvidence=evidence;status=actor==='provider'?'provider_overhead':'verified';reason=actor==='provider'?'Provider-originated traffic; not allocated to the customer.':'Single-party completion matched to the supported command and transaction.';
      }catch(e){status='pending_evidence';reason=e instanceof Error?e.message:'Transaction unavailable';}
    }
    const id=createHash('sha256').update(`${identity.user}|${identity.party}|${c.offset}`).digest('hex');
    return {id,actor,tenant:matches?known!.tenant:null,party:identity.party,user:identity.user,commandId:c.commandId,offset:c.offset,updateId:c.updateId||null,domain:c.synchronizerTime.synchronizerId,recordTime:c.synchronizerTime.recordTime,observedAt:new Date().toISOString(),bytes:c.paidTrafficCost??null,status,action:matches?known!.name:'Unsupported submission',raw:JSON.stringify(c),transactionEvidence:transactionEvidence?JSON.stringify(transactionEvidence):null,reason,policy:JSON.stringify(TEST_POLICY),amountMicro:status==='verified'?String(BigInt(c.paidTrafficCost!)*4n):null};
  }
  private save(row:any){
    this.db.prepare(`INSERT INTO usage(id,actor,tenant,party,user,commandId,offset,updateId,domain,recordTime,observedAt,bytes,status,action,raw,transactionEvidence,reason,policy,amountMicro) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant,action=excluded.action,status=excluded.status,transactionEvidence=excluded.transactionEvidence,reason=excluded.reason,amountMicro=excluded.amountMicro WHERE usage.status IN ('pending_evidence','pending_measurement','unsupported')`).run(...['id','actor','tenant','party','user','commandId','offset','updateId','domain','recordTime','observedAt','bytes','status','action','raw','transactionEvidence','reason','policy','amountMicro'].map(k=>row[k]));
  }
  async sync(){
    if(this.syncing)return;this.syncing=true;
    try{
      const config=this.config(),commands=this.commands();
      for(const actor of ['provider','atlas','nova'] as const){
        const identity=config[actor];
        const cursor=this.db.prepare('SELECT * FROM cursors WHERE actor=?').get(actor) as any;
        try{
          if(cursor&&(cursor.party!==identity.party||cursor.user!==identity.user))throw new Error('Identity changed. Do not reuse the old cursor or billing records with a reset network.');
          const response=await this.call(identity.user,'/v2/commands/command-completions?limit=100&stream_idle_timeout_ms=1000',{parties:[identity.party],beginExclusive:cursor?.offset||0});
          if(!Array.isArray(response))throw new Error('Unexpected completion stream response.');
          let offset=cursor?.offset||0;const rows=[];
          for(const envelope of response){
            const completion=envelope.completionResponse?.Completion?.value;
            const checkpoint=envelope.completionResponse?.OffsetCheckpoint?.value;
            if(completion){const row=await this.prepare(completion,actor,identity,commands);offset=Math.max(offset,row.offset);rows.push(row);}
            else if(checkpoint)offset=Math.max(offset,integer.parse(checkpoint.offset));
            else throw new Error('Unknown completion stream element; cursor not advanced.');
          }
          this.db.exec('BEGIN IMMEDIATE');
          try{for(const row of rows)this.save(row);this.db.prepare('INSERT INTO cursors VALUES (?,?,?,?,NULL,?) ON CONFLICT(actor) DO UPDATE SET offset=excluded.offset,error=NULL,checkedAt=excluded.checkedAt').run(actor,identity.party,identity.user,offset,new Date().toISOString());this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
          const pending=this.db.prepare("SELECT raw FROM usage WHERE actor=? AND status IN ('pending_evidence','pending_measurement','unsupported') LIMIT 100").all(actor) as any[];
          for(const row of pending)this.save(await this.prepare(JSON.parse(row.raw),actor,identity,commands));
        }catch(e){this.db.prepare('INSERT INTO cursors VALUES (?,?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET error=excluded.error,checkedAt=excluded.checkedAt').run(actor,identity.party,identity.user,cursor?.offset||0,e instanceof Error?e.message:'Metering unavailable',new Date().toISOString());}
      }
    }finally{this.syncing=false;}
  }
  state(tenant?:string){
    const rows=(tenant?this.db.prepare("SELECT * FROM usage WHERE actor=? ORDER BY offset DESC LIMIT 200").all(tenant):this.db.prepare('SELECT * FROM usage ORDER BY offset DESC LIMIT 500').all()) as any[];
    const totals=(tenant?this.db.prepare('SELECT status,SUM(bytes) AS bytes,COUNT(*) AS count FROM usage WHERE actor=? GROUP BY status').all(tenant):this.db.prepare('SELECT status,SUM(bytes) AS bytes,COUNT(*) AS count FROM usage GROUP BY status').all());
    const cursors=tenant?this.db.prepare('SELECT * FROM cursors WHERE actor=?').all(tenant):this.db.prepare('SELECT * FROM cursors').all();
    const invoices=(tenant?this.db.prepare('SELECT body FROM test_invoices WHERE tenant=? ORDER BY createdAt DESC').all(tenant):this.db.prepare('SELECT body FROM test_invoices ORDER BY createdAt DESC').all()) as any[];
    const periods:Record<string,string[]>={};
    for(const actor of tenant?[tenant]:['atlas','nova']){
      const times=(this.db.prepare("SELECT recordTime FROM usage WHERE actor=? AND status='verified'").all(actor) as any[]).map(r=>Date.parse(r.recordTime));
      if(!times.length){periods[actor]=[];continue;}
      this.db.prepare('INSERT OR IGNORE INTO anchors VALUES (?,?)').run(actor,Math.floor(Math.min(...times)/86400000)*86400000);
      const anchor=(this.db.prepare('SELECT anchor FROM anchors WHERE actor=?').get(actor) as any).anchor;
      periods[actor]=[...new Set(times.map(time=>new Date(periodFor(time,anchor)).toISOString()))].sort();
    }
    return {periods,network:'LocalNet',policy:TEST_POLICY,rows:rows.map(row=>this.view(row)),totals,cursors,invoices:invoices.map(row=>JSON.parse(row.body)),scope:'Measured confirmation-request traffic for supported single-party commands. Not total node traffic, remaining capacity, or CC burn.'};
  }
  invoice(tenant:'atlas'|'nova',anchor:number){
    // Immutable local test preview; never a payable invoice or an advance of the ledger clock.
    const start=new Date(anchor).toISOString(),end=new Date(anchor+BILLING_PERIOD).toISOString();
    const rows=(this.db.prepare("SELECT * FROM usage WHERE actor=? AND status='verified' ORDER BY offset").all(tenant) as any[]).filter(row=>Date.parse(row.recordTime)>=anchor&&Date.parse(row.recordTime)<anchor+BILLING_PERIOD);
    if(!rows.length)throw new AppError('NO_VERIFIED_USAGE','No verified customer usage in this fifteen-day window.');
    const total=rows.reduce((sum,row)=>sum+BigInt(row.amountMicro),0n);
    const fingerprint=createHash('sha256').update(JSON.stringify({tenant,start,ids:rows.map(r=>r.id),policy:TEST_POLICY.id})).digest('hex').slice(0,20);
    const id=`TEST-METERED-${fingerprint}`;
    const existing=this.db.prepare('SELECT body FROM test_invoices WHERE id=?').get(id) as any;if(existing)return JSON.parse(existing.body);
    const body={id,tenant,periodStart:start,periodEnd:end,createdAt:new Date().toISOString(),status:'test_preview',payable:false,totalUsd:format(total,6),policy:TEST_POLICY,lines:rows.map(row=>({usageId:row.id,action:row.action,bytes:row.bytes,recordTime:row.recordTime,observedAt:row.observedAt,updateId:row.updateId,completionOffset:row.offset,chargeUsd:format(row.amountMicro,6)})),notice:'TEST PREVIEW — NOT PAYABLE. Real LocalNet measurements; fixture commercial tariff. Period may still be open. Snapshot includes only listed verified successful completions; later evidence requires a new preview, not an additional bill.'};
    this.db.prepare('INSERT INTO test_invoices VALUES (?,?,?,?,?,?)').run(id,tenant,start,end,body.createdAt,JSON.stringify(body));return body;
  }
}
