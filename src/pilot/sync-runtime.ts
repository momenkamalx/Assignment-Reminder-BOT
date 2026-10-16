import {jidNormalizedUser,type AuthenticationState} from '@whiskeysockets/baileys';
import {diagnostic,type DiagnosticSink} from '../diagnostics.js';
import type {synchronizationSocket} from './sync-socket.js';

export async function observeSynchronization(deps:{auth:AuthenticationState;saveCreds():Promise<void>;expectedAccount:string;
  create(sink:DiagnosticSink):ReturnType<typeof synchronizationSocket>;sink:DiagnosticSink;signal?:AbortSignal;
  state(snapshot:{websocketOpen:boolean;eventBuffering:boolean;pendingNotifications:boolean;accountVerified:boolean}):void}) {
  let saves=Promise.resolve(),done=false,pendingNotifications=false,accountVerified=false;
  let finish!:()=>void;const ended=new Promise<void>(resolve=>{finish=()=>{if(!done){done=true;resolve();}};});
  const active=deps.create(deps.sink);const socket=active.socket;
  const credentials=()=>{saves=saves.then(async()=>{diagnostic(deps.sink,'credentials_save_attempt');await deps.saveCreds();diagnostic(deps.sink,'credentials_save_ok');}).catch(()=>{diagnostic(deps.sink,'credentials_save_failed');finish();});};
  let observation:ReturnType<typeof setTimeout>|undefined;
  // The transport can open before the SDK emits its authenticated connection update.
  // Start once, on the actual WebSocket, and never extend this deadline.
  const opened=()=>{
    if(done||observation!==undefined)return;
    clearTimeout(connectLimit);
    observation=setTimeout(()=>{diagnostic(deps.sink,'sync_duration_elapsed');finish();},180_000);
  };
  const connection=(event:{connection?:string;qr?:string;receivedPendingNotifications?:boolean})=>{
    if(done)return;
    if(event.qr){diagnostic(deps.sink,'sdk_error');finish();return;}
    if(event.connection==='connecting')diagnostic(deps.sink,'sync_connecting');
    if(event.connection==='open'){
      diagnostic(deps.sink,'sync_open');accountVerified=[socket.user?.id,socket.user?.lid].some(id=>id&&jidNormalizedUser(id)===deps.expectedAccount);
      if(!accountVerified){diagnostic(deps.sink,'sdk_error');finish();return;}diagnostic(deps.sink,'sync_account_verified');
    }
    if(event.receivedPendingNotifications===false)diagnostic(deps.sink,'sync_pending_false');
    if(event.receivedPendingNotifications===true){pendingNotifications=true;diagnostic(deps.sink,'sync_pending_true');finish();}
    if(event.connection==='close'){diagnostic(deps.sink,'sync_closed');if(!done)diagnostic(deps.sink,'sync_unexpected_close');finish();}
  };
  socket.ev.on('creds.update',credentials);socket.ev.on('connection.update',connection);
  let priorBuffer:boolean|undefined;
  const snapshot=()=>{const buffering=socket.ev.isBuffering();if(buffering!==priorBuffer){diagnostic(deps.sink,buffering?'sync_buffer_active':'sync_buffer_released');priorBuffer=buffering;}
    deps.state({websocketOpen:socket.ws.isOpen,eventBuffering:buffering,pendingNotifications,accountVerified});};
  const poll=setInterval(snapshot,250);
  const connectLimit=setTimeout(()=>{diagnostic(deps.sink,'sync_connection_timeout');finish();},60_000);
  socket.ws.on('open',opened);
  if(socket.ws.isOpen)opened();
  deps.signal?.addEventListener('abort',finish,{once:true});if(deps.signal?.aborted)finish();
  try{await ended;}finally{
    clearInterval(poll);clearTimeout(connectLimit);clearTimeout(observation);deps.signal?.removeEventListener('abort',finish);
    socket.ws.off('open',opened);
    try{
      snapshot();
    }finally{
      try{await socket.end(undefined);}finally{
        try{await active.drainKeys();await saves;snapshot();}finally{
          socket.ev.off('creds.update',credentials);socket.ev.off('connection.update',connection);diagnostic(deps.sink,'sync_finished');
        }
      }
    }
  }
}
