import { mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { runtimeConfig } from '../dist-backend/config.js';
import { WalletFunding } from '../dist-backend/wallet-funding.js';
import { walletConnector } from '../dist-backend/wallet-connector.js';
import { createApp } from '../dist-backend/app.js';
import { IdentityStore } from '../dist-backend/auth.js';
import { Store } from '../dist-backend/store.js';

if (!process.argv.includes('--execute')) throw new Error('Pass --execute to authorize one real LocalNet 1 CC transfer to Atlas.');
const config=runtimeConfig();
if(config.networkMode!=='localnet')throw new Error('Set CLEARROUTE_NETWORK_MODE=localnet and the existing CLEARROUTE_LOCALNET_CONFIG.');
mkdirSync(config.dataDir,{recursive:true});
const service=new WalletFunding(config.dataDir,walletConnector(config.localnetConfig));
const store=new Store(':memory:'),identities=new IdentityStore(':memory:');
const tokens={};
for(const role of ['operator','atlas','nova']) {
  identities.createAccount({id:role+'-acceptance',name:role,...(role==='operator'?{role:'operator',tenantId:null}:{role:'customer',tenantId:role})});
  tokens[role]=identities.issueKey(role+'-acceptance').token;
}
const server=createApp(store,undefined,undefined,undefined,undefined,undefined,{mode:'required',identities},undefined,service).listen(0,'127.0.0.1');
await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
async function call(role,route,body) {
  const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${tokens[role]}`,'content-type':'application/json','idempotency-key':'wallet-localnet-acceptance-v1'},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await r.json();if(!r.ok)throw new Error(`${r.status}: ${value.error?.message}`);return value;
}
try {
  const before=await call('operator','/api/wallet-funding');
  if(before.wallets.some(w=>w.error))throw new Error(`Wallet setup required: ${JSON.stringify(before.wallets)}`);
  let result=(await call('operator','/api/wallet-funding',{tenantId:'atlas',amountCc:'1'})).result;
  const other=await call('nova','/api/wallet-funding');
  if(other.transfers.some(t=>t.id===result.id))throw new Error('Cross-tenant transfer exposure.');
  result=(await call('atlas',`/api/wallet-funding/${result.id}/accept`,{})).result;
  for(let n=0;n<36&&!['completed','failed'].includes(result.status);n++) {
    await new Promise(resolve=>setTimeout(resolve,5000));
    result=(await call('atlas',`/api/wallet-funding/${result.id}/reconcile`,{})).result;
    console.log(`Transfer ${result.id}: ${result.status}${result.error ? ' - '+result.error : ''}`);
  }
  if(result.status!=='completed'||!result.receipt)throw new Error(`Delivery not verified: ${JSON.stringify(result)}`);
  const replay=(await call('operator','/api/wallet-funding',{tenantId:'atlas',amountCc:'1'})).result;
  if(replay.id!==result.id)throw new Error('Transfer replay changed identity.');
  const after=await call('atlas','/api/wallet-funding');
  const evidence={network:'LocalNet',verifiedAt:new Date().toISOString(),result,wallets:after.wallets};
  const destination=path.join(config.dataDir,'wallet-funding-evidence.json');
  writeFileSync(destination,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({ok:true,receipt:result.receipt,evidence:destination},null,2));
} finally {
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();identities.close();store.close();
}
