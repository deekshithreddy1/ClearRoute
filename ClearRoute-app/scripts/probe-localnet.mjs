import { createHmac } from 'node:crypto';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(sub) { const data = `${part({alg:'HS256',typ:'JWT'})}.${part({sub,aud:'https://canton.network.global',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300})}`; return `${data}.${createHmac('sha256','unsafe').update(data).digest('base64url')}`; }
for (const [base, user, route] of [
 ['http://127.0.0.1:3975','ledger-api-user','/v2/users'],
 ['http://127.0.0.1:3903','app-provider','/api/validator/v0/wallet/user-status'],
 ['http://127.0.0.1:3903','app-provider','/api/validator/v0/scan-proxy/dso-party-id'],
]) {
 const response = await fetch(base+route,{headers:{Authorization:`Bearer ${token(user)}`},signal:AbortSignal.timeout(15000)});
 console.log(route,response.status,(await response.text()).slice(0,2500));
}
