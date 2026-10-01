import { AppError } from './money.js';

export type TrafficRequest = {
  receiving_validator_party_id:string; domain_id:string; traffic_amount:number;
  tracking_id:string; expires_at:number;
};

export class WalletApiError extends Error {
  constructor(public status:number, message:string) { super(message); }
}
/** Native wallet integration; local deployments explicitly opt into loopback HTTP. */
export class WalletTrafficAdapter {
  private base:URL;
  constructor(baseUrl:string,private token:()=>Promise<string>,private allowedDestinations:Set<string>,private testLoopback=false) {
    this.base = new URL(baseUrl);
    if (this.base.username || this.base.password || this.base.search || this.base.hash) throw new AppError('INVALID_ENDPOINT','Use a clean wallet API base URL.');
    if (this.base.protocol !== 'https:' && !(testLoopback && this.base.protocol==='http:' && this.base.hostname==='127.0.0.1')) throw new AppError('INVALID_ENDPOINT','Hosted wallet API requires HTTPS.');
    this.base.pathname=this.base.pathname.replace(/\/$/,'')+'/';
  }
  private async call(route:string,body:unknown) {
    const response = await fetch(new URL(route,this.base),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${await this.token()}`},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new WalletApiError(response.status,`Wallet ${response.status}: ${(await response.text()).slice(0,800)}`);
    return response.json() as Promise<unknown>;
  }
  async create(request:TrafficRequest) {
    if (!this.allowedDestinations.has(`${request.domain_id}|${request.receiving_validator_party_id}`)) throw new AppError('DESTINATION_NOT_ALLOWED','The validator/synchronizer pair is not approved.');
    if (!Number.isSafeInteger(request.traffic_amount) || request.traffic_amount<=0 || !Number.isSafeInteger(request.expires_at) || request.expires_at<=Date.now()*1000 || !request.tracking_id) throw new AppError('INVALID_TRAFFIC_REQUEST','Invalid quantity, expiry or tracking ID.');
    return this.call('v0/wallet/buy-traffic-requests',request);
  }
  async status(trackingId:string) {
    if (!trackingId || trackingId.length>200) throw new AppError('INVALID_TRACKING_ID','A persisted tracking ID is required.');
    return this.call(`v0/wallet/buy-traffic-requests/${encodeURIComponent(trackingId)}/status`,{});
  }
}
