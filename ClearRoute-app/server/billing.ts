import type {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {AppError,decimal,format} from './money.js';

type Row=Record<string,any>;
const DAY=86400000;
const micro=(value:string)=>/^0(?:\.0+)?$/.test(value)?0n:decimal(value,6);
export class Billing {
  constructor(private db:DatabaseSync,private clock=Date.now){
    db.exec(`
      CREATE TABLE IF NOT EXISTS billing_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_invoices(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,dueAt TEXT NOT NULL,createdAt TEXT NOT NULL,totalMicro TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(tenant,start));
      CREATE TABLE IF NOT EXISTS billing_lines(usageId TEXT PRIMARY KEY,invoiceId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_payments(id TEXT PRIMARY KEY,invoiceId TEXT NOT NULL,amountMicro TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,status TEXT NOT NULL,createdAt TEXT NOT NULL,decisionAt TEXT,decisionNote TEXT);
      CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,tenant TEXT,at TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_operations(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,response TEXT NOT NULL);
    `);
    db.prepare("INSERT OR IGNORE INTO billing_meta VALUES ('offset','0')").run();
  }
  now(){return this.clock()+Number((this.db.prepare("SELECT value FROM billing_meta WHERE key='offset'").get() as Row).value);}
  private rows(sql:string,...args:any[]){return this.db.prepare(sql).all(...args) as Row[];}
  private event(tenant:string|null,kind:string,body:unknown){this.db.prepare('INSERT INTO billing_events VALUES (?,?,?,?,?)').run(randomUUID(),tenant,new Date(this.now()).toISOString(),kind,JSON.stringify(body));}
  // Single SQLite transaction covers business state, audit, and the replay response.
  mutate(key:string,operation:string,payload:unknown,run:()=>unknown):any {
    if(!/^[\w-]{8,100}$/.test(key))throw new AppError('IDEMPOTENCY_REQUIRED','A stable operation key is required.');
    const fingerprint=createHash('sha256').update(JSON.stringify({operation,payload})).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const old=this.db.prepare('SELECT * FROM billing_operations WHERE key=?').get(key) as Row|undefined;
      if(old){if(old.fingerprint!==fingerprint)throw new AppError('KEY_CONFLICT','This operation key was used for different input.',409);this.db.exec('COMMIT');return JSON.parse(old.response);}
      const result=run();this.db.prepare('INSERT INTO billing_operations VALUES (?,?,?)').run(key,fingerprint,JSON.stringify(result));this.db.exec('COMMIT');return result;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  advance(){const row=this.db.prepare("SELECT value FROM billing_meta WHERE key='offset'").get() as Row;this.db.prepare("UPDATE billing_meta SET value=? WHERE key='offset'").run(String(Number(row.value)+15*DAY));this.event(null,'sandbox.clock_advanced',{days:15});return {now:new Date(this.now()).toISOString()};}
  finalize(preview:Row){
    const old=this.db.prepare('SELECT id FROM billing_invoices WHERE tenant=? AND start=?').get(preview.tenant,preview.periodStart) as Row|undefined;
    if(old)return this.invoice(old.id);
    if(Date.parse(preview.periodEnd)>this.now())throw new AppError('PERIOD_OPEN','This period is still open. Advance the sandbox billing clock to test finalization.');
    if(preview.payable!==false||preview.policy?.id!=='measured-fixture-v1')throw new AppError('UNSUPPORTED_POLICY','Only the measured fixture policy is enabled. Commercial terms are not configured.');
    const total=preview.lines.reduce((sum:bigint,line:Row)=>sum+micro(line.chargeUsd),0n);
    if(format(total,6)!==preview.totalUsd)throw new AppError('TOTAL_MISMATCH','Invoice evidence does not match its total.');
    const id='SANDBOX-'+createHash('sha256').update(preview.tenant+'|'+preview.periodStart).digest('hex').slice(0,20);
    const createdAt=new Date(this.now()).toISOString(),dueAt=new Date(this.now()+15*DAY).toISOString();
    const body={...preview,id,sourcePreviewId:preview.id,createdAt,dueAt,status:'issued',payable:false,mode:'sandbox',currency:'USD',notice:'SANDBOX INVOICE — NOT PAYABLE. Fixture tariff and simulated USD payment records only. No bank, wallet or payment provider is connected.'};
    for(const line of preview.lines)if(this.db.prepare('SELECT usageId FROM billing_lines WHERE usageId=?').get(line.usageId))throw new AppError('ALREADY_BILLED','A measured usage record already belongs to a finalized invoice.',409);
    this.db.prepare('INSERT INTO billing_invoices VALUES (?,?,?,?,?,?,?,?)').run(id,preview.tenant,preview.periodStart,preview.periodEnd,dueAt,createdAt,String(total),JSON.stringify(body));
    for(const line of preview.lines)this.db.prepare('INSERT INTO billing_lines VALUES (?,?)').run(line.usageId,id);
    this.event(preview.tenant,'invoice.finalized',{id,sourcePreviewId:preview.id,totalUsd:preview.totalUsd});return this.invoice(id);
  }
  invoice(id:string){
    const row=this.db.prepare('SELECT * FROM billing_invoices WHERE id=?').get(id) as Row|undefined;
    if(!row)throw new AppError('NOT_FOUND','Finalized invoice not found.',404);
    const payments=this.rows('SELECT * FROM billing_payments WHERE invoiceId=? ORDER BY createdAt,id',id);
    const paid=payments.filter(p=>p.status==='confirmed').reduce((sum,p)=>sum+BigInt(p.amountMicro),0n),outstanding=BigInt(row.totalMicro)-paid;
    return {...JSON.parse(row.body),paidUsd:format(paid,6),outstandingUsd:format(outstanding,6),status:outstanding===0n?'paid':this.now()>Date.parse(row.dueAt)?'overdue':paid>0n?'partially_paid':'issued',payments:payments.map(p=>({...p,amountUsd:format(p.amountMicro,6)}))};
  }
  payment(invoiceId:string,amountUsd:string,reference:string){
    const inv=this.invoice(invoiceId),amount=decimal(amountUsd,6),normalized=reference.trim().toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9._:/-]{3,119}$/.test(normalized))throw new AppError('INVALID_REFERENCE','Use a unique 4–120 character test reference (letters, numbers, dot, dash, slash or colon).');
    const old=this.db.prepare('SELECT * FROM billing_payments WHERE reference=?').get(normalized) as Row|undefined;
    if(old){if(old.invoiceId!==invoiceId||old.amountMicro!==String(amount))throw new AppError('REFERENCE_CONFLICT','That payment reference is already recorded with different details.',409);return this.invoice(invoiceId);}
    const reserved=inv.payments.filter((p:Row)=>p.status==='pending').reduce((sum:bigint,p:Row)=>sum+BigInt(p.amountMicro),0n);
    if(amount>micro(inv.outstandingUsd)-reserved)throw new AppError('OVERPAYMENT','The amount exceeds the balance after pending payments.');
    this.db.prepare('INSERT INTO billing_payments VALUES (?,?,?,?,?,?,NULL,NULL)').run(randomUUID(),invoiceId,String(amount),normalized,'pending',new Date(this.now()).toISOString());
    this.event(inv.tenant,'payment.recorded',{invoiceId,amountUsd:format(amount,6),reference:normalized});return this.invoice(invoiceId);
  }
  decide(paymentId:string,decision:'confirmed'|'rejected'|'reversed',note:string){
    const p=this.db.prepare('SELECT * FROM billing_payments WHERE id=?').get(paymentId) as Row|undefined;if(!p)throw new AppError('NOT_FOUND','Payment record not found.',404);
    const inv=this.invoice(p.invoiceId);
    if(!note.trim()||note.trim().length>240)throw new AppError('NOTE_REQUIRED','Provide a reconciliation note (1–240 characters).');
    if(p.status===decision)return inv;
    if(decision==='reversed'?p.status!=='confirmed':p.status!=='pending')throw new AppError('INVALID_TRANSITION','This payment cannot make the requested status change.',409);
    if(decision==='confirmed'&&BigInt(p.amountMicro)>micro(inv.outstandingUsd))throw new AppError('OVERPAYMENT','Confirmation would exceed the invoice balance.');
    this.db.prepare('UPDATE billing_payments SET status=?,decisionAt=?,decisionNote=? WHERE id=?').run(decision,new Date(this.now()).toISOString(),note.trim(),paymentId);
    this.event(inv.tenant,'payment.'+decision,{paymentId,invoiceId:p.invoiceId,amountUsd:format(p.amountMicro,6),note:note.trim()});return this.invoice(p.invoiceId);
  }
  state(tenant?:string){
    const invoices=this.rows('SELECT id FROM billing_invoices'+(tenant?' WHERE tenant=?':'')+' ORDER BY createdAt DESC',...(tenant?[tenant]:[])).map(r=>this.invoice(r.id));
    const audit=this.rows('SELECT * FROM billing_events'+(tenant?' WHERE tenant=?':'')+' ORDER BY at DESC,rowid DESC LIMIT 100',...(tenant?[tenant]:[])).map(r=>({...r,kind:String(r.kind),body:JSON.parse(r.body)}));
    // Late-arriving verified records are visible for review, never silently billed twice.
    const lateUsage=this.rows("SELECT u.id,u.actor,u.recordTime,u.bytes,b.id AS invoiceId FROM usage u JOIN billing_invoices b ON b.tenant=u.actor LEFT JOIN billing_lines l ON l.usageId=u.id WHERE u.status='verified' AND l.usageId IS NULL"+(tenant?' AND u.actor=?':''),...(tenant?[tenant]:[])).filter(r=>{const inv=invoices.find(i=>i.id===r.invoiceId);return inv&&Date.parse(r.recordTime)>=Date.parse(inv.periodStart)&&Date.parse(r.recordTime)<Date.parse(inv.periodEnd);});
    return {mode:'sandbox',commercialEnabled:false,now:new Date(this.now()).toISOString(),invoices,audit,lateUsage};
  }
}
