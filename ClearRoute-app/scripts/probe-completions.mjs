import {readFileSync,writeFileSync} from 'node:fs';
import {ledger} from '../dist-server/localnet-client.js';
const config=JSON.parse(readFileSync('data/localnet.json','utf8'));
const result=await ledger(config.atlas.user,'/v2/commands/command-completions?limit=100&stream_idle_timeout_ms=1000',{parties:[config.atlas.party],beginExclusive:0});
writeFileSync('evidence/atlas-completions.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result).slice(0,7000));
