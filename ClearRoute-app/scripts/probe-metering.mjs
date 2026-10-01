import {readFileSync} from 'node:fs';
import {ledger} from '../dist-server/localnet-client.js';
const config=JSON.parse(readFileSync('data/localnet.json','utf8'));
const saved=JSON.parse(readFileSync('evidence/localnet-atlas.json','utf8'));
for(const step of saved.result.steps){
 const actor=['Customer accepts','Customer submits sample'].includes(step.name)?config.atlas:config.provider;
 const {transaction}=await ledger(actor.user,'/v2/updates/transaction-by-id',{updateId:step.updateId,requestingParties:[actor.party]});
 console.log(JSON.stringify({step:step.name,user:actor.user,commandId:transaction.commandId,updateId:transaction.updateId,offset:transaction.offset,paidTrafficCost:transaction.paidTrafficCost,keys:Object.keys(transaction)}));
}
try{console.log(await ledger(config.atlas.user,`/v2/traffic/accounts/${encodeURIComponent(config.atlas.party)}`));}catch(e){console.log('Accounting API:',e.message);}
