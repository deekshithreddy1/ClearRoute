import { localToken } from '../dist-server/localnet-client.js';
import { writeFileSync } from 'node:fs';
for(const route of ['v0/wallet/balance','v0/admin/participant/global-domain-connection-config','v0/scan-proxy/amulet-rules','v0/wallet/user-status']) {
 const response=await fetch('http://127.0.0.1:3903/api/validator/'+route,{headers:{Authorization:`Bearer ${localToken('app-provider')}`},signal:AbortSignal.timeout(15000)});
 const text=await response.text();
 writeFileSync('evidence/'+route.split('/').at(-1)+'.json',text);
 console.log(route,response.status,text.slice(0,route.includes('amulet-rules')?9000:4000));
}
