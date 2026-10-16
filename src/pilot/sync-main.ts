import {readFile,open,writeFile} from 'node:fs/promises';
import {useMultiFileAuthState} from '@whiskeysockets/baileys';
import {pilotConfig} from './config.js';import {checkPilot} from './preflight.js';import {verifiedProposal} from './proposal.js';
import {synchronizationSocket} from './sync-socket.js';import {observeSynchronization} from './sync-runtime.js';
import type {DiagnosticEvent} from '../diagnostics.js';

const original={log:console.log,info:console.info,warn:console.warn,error:console.error,debug:console.debug,trace:console.trace};const report=console.log.bind(console);
const abort=new AbortController();process.once('SIGINT',()=>abort.abort());process.once('SIGTERM',()=>abort.abort());
let fatal=()=>{report(JSON.stringify({code:'sdk_error',count:1}));abort.abort();};
process.on('unhandledRejection',()=>fatal());process.once('uncaughtException',()=>fatal());
let lock:Awaited<ReturnType<typeof open>>|undefined;
try{
  const config=await pilotConfig('sync');await checkPilot(process.cwd(),process.env);
  const proposal=verifiedProposal(JSON.parse(await readFile('data/pilot/metadata-result.json','utf8')));
  if(config.expectedAccount!==proposal.expectedAccount||JSON.stringify(config.groups)!==JSON.stringify(proposal.groups))throw Error('Verified sync configuration mismatch.');
  const run=process.env.PILOT_SYNC_RUN;if(!run||!/^sync-\d{8}-[a-z0-9-]+$/.test(run))throw Error('Fresh sync run identifier required.');
  lock=await open(`data/pilot/${run}.intent.json`,'wx');await lock.writeFile(JSON.stringify({started:true,applicationMessages:false}));await lock.close();lock=undefined;
  const statusPath=`data/pilot/${run}.status.json`;const counts:Record<string,number>={};let state:unknown={};let updates=Promise.resolve();
  const persist=()=>{updates=updates.then(()=>writeFile(statusPath,JSON.stringify({counts,state,applicationMessages:false})));};
  const sink=(event:DiagnosticEvent)=>{counts[event.code]=(counts[event.code]??0)+event.count;report(JSON.stringify(event));};
  fatal=()=>{sink({code:'sdk_error',count:1});abort.abort();};
  const auth=await useMultiFileAuthState(config.authDir);
  for(const key of ['log','info','warn','error','debug','trace'] as const)console[key]=()=>{};
  await observeSynchronization({auth:auth.state,saveCreds:auth.saveCreds,expectedAccount:config.expectedAccount!,sink,signal:abort.signal,
    create:diagnostics=>synchronizationSocket(auth.state,proposal.group.id,diagnostics),state:snapshot=>{state=snapshot;persist();}});
  persist();await updates;report('Synchronization-only diagnostic stopped; session preserved; application messages disabled.');
}catch{report('Synchronization-only diagnostic refused or stopped with error; no automatic retry.');process.exitCode=1;}
finally{await lock?.close();Object.assign(console,original);}
