import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localToken, ledger } from './localnet-client.js';
import { WalletTrafficAdapter, WalletApiError, type TrafficRequest } from './wallet-adapter.js';
import { AppError } from './money.js';

const BASE='http://127.0.0.1:3903/api/validator/';
const MAX_BYTES=1_000_000, TOTAL_LIMIT=10_000_000;
const statusSchema=z.discriminatedUnion('status',[
  z.object({status:z.literal('created')}),
  z.object({status:z.literal('completed'),transaction_id:z.string().min(1)}),
  z.object({status:z.literal('failed'),failure_reason:z.enum(['expired','rejected']),rejection_reason:z.string().optional()}),
]);
export type TrafficTarget={party:string;domain:string;minBytes:number;balanceCc:string;checkedAt:string};
export async function trafficTarget():Promise<TrafficTarget> {
  async function get(route:string) {
    const response=await fetch(BASE+route,{redirect:'error',headers:{Authorization:`Bearer ${localToken('app-provider')}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error(`LocalNet wallet read failed (${response.status}).`);
    return response.json() as Promise<any>;
  }
  const [wallet,rules,balance]=await Promise.all([get('v0/wallet/user-status'),get('v0/scan-proxy/amulet-rules'),get('v0/wallet/balance')]);
  const payload=rules.amulet_rules?.contract?.payload;
  if(payload?.isDevNet!==true || !wallet.user_wallet_installed || !wallet.user_onboarded || !wallet.party_id?.startsWith('app_provider_launchfuel-local-1::'))
    throw new Error('Expected the bundled launchfuel LocalNet provider wallet. Purchases disabled.');
  const schedule=payload.configSchedule;
  let config=schedule.initialValue;
  for(const item of [...schedule.futureValues].sort((a:any,b:any)=>Date.parse(a._1)-Date.parse(b._1))) {
    if(!Number.isFinite(Date.parse(item._1))) throw new Error('Unsupported traffic configuration schedule.');
    if(Date.parse(item._1)<=Date.now()) config=item._2;
  }
  const domain=config.decentralizedSynchronizer?.activeSynchronizer;
  const minBytes=Number(config.decentralizedSynchronizer?.fees?.minTopupAmount);
  if(typeof domain!=='string' || domain!==rules.amulet_rules.domain_id || !Number.isSafeInteger(minBytes) || minBytes<=0 || minBytes>MAX_BYTES || !/^\d+(\.\d+)?$/.test(balance.effective_unlocked_qty))
    throw new Error('Unsupported LocalNet traffic configuration. Purchases disabled.');
  return {party:wallet.party_id,domain,minBytes,balanceCc:balance.effective_unlocked_qty,checkedAt:new Date().toISOString()};
}
export type TrafficDependencies={
  target:()=>Promise<TrafficTarget>;
  adapter:(target:TrafficTarget)=>Pick<WalletTrafficAdapter,'create'|'status'>;
  evidence:(id:string,party:string)=>Promise<unknown>;
};
const dependencies:TrafficDependencies={
  target:trafficTarget,
  adapter:target=>new WalletTrafficAdapter(BASE,async()=>localToken('app-provider'),new Set([`${target.domain}|${target.party}`]),true),
  evidence:(id,party)=>ledger('app-provider','/v2/updates/transaction-by-id',{updateId:id,transactionFormat:{transactionShape:'TRANSACTION_SHAPE_LEDGER_EFFECTS',eventFormat:{filtersByParty:{[party]:{}},verbose:true}}}),
};
export function trafficReceipt(evidence:any,request:TrafficRequest){
  const events=evidence?.transaction?.events?.map((event:any)=>event.ExercisedEvent).filter(Boolean)||[];
  const completion=events.find((e:any)=>e.choice==='BuyTrafficRequest_Complete'&&e.exerciseResult?.trackingInfo?.trackingId===request.tracking_id);
  if(!completion?.exerciseResult?.purchasedTraffic)throw new Error('Purchase tracking ID not found in ledger transaction.');
  const buys=events.filter((e:any)=>e.choice==='AmuletRules_BuyMemberTraffic'&&e.exerciseResult?.purchasedTraffic===completion.exerciseResult.purchasedTraffic);
  if(buys.length!==1)throw new Error('Purchase evidence is missing or ambiguous.');
  const buy=buys[0],args=buy.choiceArgument,result=buy.exerciseResult;
  if(args?.synchronizerId!==request.domain_id||args?.provider!==request.receiving_validator_party_id||String(args?.trafficAmount)!==String(request.traffic_amount))throw new Error('Purchase evidence does not match requested destination or bytes.');
  const decimal=z.string().regex(/^\d+(\.\d+)?$/);
  const burnedCc=decimal.parse(result.meta?.values?.['splice.lfdecentralizedtrust.org/burned']);
  return {bytes:request.traffic_amount,burnedCc,paidCc:decimal.parse(result.amuletPaid),protocolUsdPerCc:decimal.parse(result.summary?.amuletPrice),memberId:z.string().min(1).parse(args.memberId),synchronizerId:args.synchronizerId,purchasedTrafficContractId:result.purchasedTraffic,recordTime:evidence.transaction.recordTime};
}
export class Traffic {
  private db:DatabaseSync;
  private running=false;
  constructor(directory:string,private deps:TrafficDependencies=dependencies) {
    this.db=new DatabaseSync(path.join(directory,'traffic.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY,requestKey TEXT UNIQUE NOT NULL,bytes INTEGER NOT NULL,status TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,target TEXT NOT NULL,request TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextCheck INTEGER NOT NULL DEFAULT 0,response TEXT,error TEXT,evidence TEXT);
      UPDATE purchases SET evidence=NULL WHERE evidence IS NOT NULL AND json_extract(evidence,'$.purchase') IS NULL;
    `);
  }
  close(){this.db.close();}
  get(id:string){const row=this.row(id);if(!row)throw new AppError('NOT_FOUND','Traffic purchase not found.',404);return this.view(row);}
  private row(id:string){return this.db.prepare('SELECT * FROM purchases WHERE id=?').get(id) as any;}
  private view(row:any){return {...row,requestKey:undefined,target:JSON.parse(row.target),request:JSON.parse(row.request),response:row.response?JSON.parse(row.response):null,evidence:row.evidence?JSON.parse(row.evidence):null};}
  list(){return (this.db.prepare('SELECT * FROM purchases ORDER BY createdAt DESC LIMIT 100').all() as any[]).map(row=>this.view(row));}
  async state(){
    let target:TrafficTarget|null=null,error:string|null=null;
    try{target=await this.deps.target();}catch(e){error=e instanceof Error?e.message:'Wallet unavailable';}
    const used=(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM purchases WHERE status NOT IN ('failed','rejected')").get() as any).total;
    return {network:'LocalNet',target,error,maxBytes:MAX_BYTES,totalLimitBytes:TOTAL_LIMIT,remainingLimitBytes:Math.max(0,TOTAL_LIMIT-used),purchases:this.list()};
  }
  async purchase(bytes:number,key:string){
    if(!/^[\w-]{8,150}$/.test(key)) throw new AppError('IDEMPOTENCY_REQUIRED','A stable request ID is required.');
    if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_BYTES)throw new AppError('INVALID_AMOUNT',`Choose at most ${MAX_BYTES} whole traffic bytes.`);
    const existing=this.db.prepare('SELECT * FROM purchases WHERE requestKey=?').get(key) as any;
    if(existing){if(existing.bytes!==bytes)throw new AppError('IDEMPOTENCY_CONFLICT','This request ID belongs to a different amount.',409);return this.view(existing);}
    const target=await this.deps.target();
    if(bytes<target.minBytes)throw new AppError('BELOW_MINIMUM',`Network minimum is ${target.minBytes} bytes.`);
    if(!/[1-9]/.test(target.balanceCc))throw new AppError('INSUFFICIENT_FUNDS','The LocalNet provider wallet has no unlocked test CC.');
    const id=`traffic-${randomUUID()}`,now=new Date().toISOString();
    const request:TrafficRequest={receiving_validator_party_id:target.party,domain_id:target.domain,traffic_amount:bytes,tracking_id:id,expires_at:(Date.now()+10*60*1000)*1000};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const replay=this.db.prepare('SELECT * FROM purchases WHERE requestKey=?').get(key) as any;
      if(replay){if(replay.bytes!==bytes)throw new AppError('IDEMPOTENCY_CONFLICT','Request amount changed.',409);this.db.exec('COMMIT');return this.view(replay);}
      if(this.db.prepare("SELECT id FROM purchases WHERE status NOT IN ('completed','failed','rejected')").get())throw new AppError('PURCHASE_PENDING','Resolve the existing traffic purchase before starting another.',409);
      const total=(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS total FROM purchases WHERE status NOT IN ('failed','rejected')").get() as any).total;
      if(total+bytes>TOTAL_LIMIT)throw new AppError('LOCAL_LIMIT','The 10 MB LocalNet test purchase limit has been reached.');
      this.db.prepare('INSERT INTO purchases(id,requestKey,bytes,status,createdAt,updatedAt,target,request) VALUES (?,?,?,?,?,?,?,?)').run(id,key,bytes,'queued',now,now,JSON.stringify(target),JSON.stringify(request));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    await this.reconcile(id);
    return this.view(this.row(id));
  }
  private update(id:string,status:string,response:unknown,error:string|null=null){
    this.db.prepare('UPDATE purchases SET status=?,response=?,error=?,updatedAt=?,nextCheck=? WHERE id=?').run(status,response?JSON.stringify(response):null,error,new Date().toISOString(),Date.now()+5000,id);
  }
  async reconcile(id:string){
    if(this.running)return;
    const row=this.row(id);if(!row)throw new AppError('NOT_FOUND','Traffic purchase not found.',404);
    if(['failed','rejected'].includes(row.status)||row.status==='completed'&&row.evidence)return;
    this.running=true;
    try{
      const target:TrafficTarget=JSON.parse(row.target),request:TrafficRequest=JSON.parse(row.request);
      const current=await this.deps.target();
      if(current.party!==target.party||current.domain!==target.domain)throw new Error('LocalNet identity changed. Retaining original request for reconciliation.');
      const adapter=this.deps.adapter(target);
      let status:unknown;
      try{status=row.status==='completed'?JSON.parse(row.response):await adapter.status(id);}
      catch(e){
        if(!(e instanceof WalletApiError)||e.status!==404)throw e;
        // A missing status is not failure. Retry only the identical, unexpired request.
        if(request.expires_at<=Date.now()*1000||row.attempts>=3||row.status==='completed')throw new Error('Wallet status is unknown; automatic submission stopped. Check the saved tracking ID.');
        this.db.prepare("UPDATE purchases SET status='submitting',attempts=attempts+1,updatedAt=? WHERE id=?").run(new Date().toISOString(),id);
        try{
          const created=await adapter.create(request);
          z.object({request_contract_id:z.string().min(1)}).parse(created);
          this.update(id,'pending',created);
        }catch(error){
          if(error instanceof WalletApiError && error.status===400 && row.attempts===0) this.update(id,'rejected',null,error.message);
          else this.update(id,'reconciling',null,error instanceof Error?error.message:'Submission result unavailable');
        }
        return;
      }
      const parsed=statusSchema.parse(status);
      if(parsed.status==='created'){this.update(id,'pending',parsed);return;}
      if(parsed.status==='failed'){this.update(id,'failed',parsed,parsed.rejection_reason||parsed.failure_reason);return;}
      this.update(id,'completed',parsed);
      try{
        const evidence:any=await this.deps.evidence(parsed.transaction_id,target.party);
        if(evidence?.transaction?.updateId!==parsed.transaction_id)throw new Error('Transaction evidence did not match wallet confirmation.');
        const purchase=trafficReceipt(evidence,request);
        this.db.prepare('UPDATE purchases SET evidence=?,error=NULL WHERE id=?').run(JSON.stringify({...evidence,purchase}),id);
      }catch(e){this.db.prepare('UPDATE purchases SET error=? WHERE id=?').run(`Purchase confirmed; ledger evidence unavailable: ${e instanceof Error?e.message:'unknown error'}`,id);}
    }catch(e){
      if(row.status==='completed')this.db.prepare('UPDATE purchases SET error=?,nextCheck=? WHERE id=?').run(String(e),Date.now()+15000,id);
      else this.update(id,'reconciling',row.response?JSON.parse(row.response):null,e instanceof Error?e.message:'Status unavailable');
    }finally{this.running=false;}
  }
  async tick(){
    const rows=this.db.prepare("SELECT id FROM purchases WHERE (status NOT IN ('completed','failed','rejected') OR (status='completed' AND evidence IS NULL)) AND nextCheck<=? ORDER BY createdAt LIMIT 5").all(Date.now()) as any[];
    for(const row of rows)await this.reconcile(row.id);
  }
}
