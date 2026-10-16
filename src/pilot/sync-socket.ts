import makeWASocket, {type AuthenticationState,type BinaryNode} from '@whiskeysockets/baileys';
import pino from 'pino';
import {diagnostic,type DiagnosticSink} from '../diagnostics.js';
import {observeSdkLog} from './sdk-diagnostics.js';

/** Observe native protocol processing; no bot, parser, queues or application-send capability. */
export function synchronizationSocket(auth:AuthenticationState,group:string,sink:DiagnosticSink) {
  const pending=new Set<Promise<void>>();
  const observedAuth:AuthenticationState={creds:auth.creds,keys:{get:auth.keys.get.bind(auth.keys),set:data=>{
    diagnostic(sink,'signal_write_attempt');
    const write=Promise.resolve().then(()=>auth.keys.set(data)).then(()=>{diagnostic(sink,'signal_write_ok');},error=>{diagnostic(sink,'signal_write_failed');throw error;});
    pending.add(write);void write.then(()=>pending.delete(write),()=>pending.delete(write));return write;
  }}};
  // Hooks run BEFORE pino serialization. Drop every SDK argument after fixed-code classification.
  const logger=pino({level:'debug',hooks:{logMethod(args,_method,level){
    const message=typeof args[0]==='string'?args[0]:typeof args[1]==='string'?args[1]:'';
    if(level>=40)observeSdkLog(JSON.stringify({level,msg:message}),sink);
    if(message==='offline preview received')diagnostic(sink,'offline_batch_request_attempt');
    if(message==='Event buffer activated')diagnostic(sink,'sync_buffer_active');
    if(message==='sent ack'){
      diagnostic(sink,'protocol_ack_attempt');
      const tag=(args[0] as {recv?:{tag?:string}})?.recv?.tag;
      if(tag==='notification')diagnostic(sink,'protocol_notification_ack_attempt');
      if(tag==='receipt')diagnostic(sink,'protocol_receipt_ack_attempt');
      if(tag==='message')diagnostic(sink,'protocol_message_ack_attempt');
    }
    if(message==='sending receipt for messages')diagnostic(sink,'protocol_receipt_attempt');
    // Deliberately never call the supplied log method or inspect metadata/error/body fields.
  }}},{write:()=>{}});
  const socket=makeWASocket({auth:observedAuth,logger,fireInitQueries:false,emitOwnEvents:false,markOnlineOnConnect:false,
    syncFullHistory:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>jid!==group,
    enableRecentMessageCache:false,maxMsgRetryCount:0,defaultQueryTimeoutMs:20000});
  // No participating-group enumeration and no re-pairing; normal message/notification/receipt hooks stay intact.
  for(const event of ['CB:ib,,dirty','CB:iq,type:set,pair-device','CB:iq,,pair-success'])socket.ws.removeAllListeners(event);
  socket.ws.on('message',()=>diagnostic(sink,'wire_payload_received'));
  socket.ws.on('frame',(frame:BinaryNode|Uint8Array)=>{
    diagnostic(sink,'decoded_frame_received');if(frame instanceof Uint8Array)return;
    diagnostic(sink,frame.tag==='message'?'decoded_message_frame':frame.tag==='notification'?'decoded_notification_frame':'decoded_other_frame');
    if(frame.tag==='ib'&&Array.isArray(frame.content))for(const child of frame.content){
      if(child.tag==='offline_preview')diagnostic(sink,'pending_offline_preview_frame');
      if(child.tag==='offline')diagnostic(sink,'pending_offline_marker_frame');
    }
  });
  socket.ws.on('CB:ib,,offline_preview',()=>diagnostic(sink,'pending_offline_preview_callback'));
  socket.ws.on('CB:ib,,offline',()=>diagnostic(sink,'pending_offline_marker_callback'));
  socket.ws.on('CB:message',(node:BinaryNode)=>{
    diagnostic(sink,'transport_message_received');
    if(node.attrs.from!==group){diagnostic(sink,'transport_route_rejected');return;}
    diagnostic(sink,'raw_group_message');diagnostic(sink,node.attrs.offline===undefined?'offline_flag_absent':node.attrs.offline==='0'?'offline_flag_zero':node.attrs.offline==='1'?'offline_flag_one':'offline_flag_other');
    // Observe only; SDK's original handler performs its ordinary classification and protocol work.
  });
  socket.ev.on('messages.upsert',event=>{
    diagnostic(sink,'upsert_received');diagnostic(sink,event.type==='notify'?'upsert_notify':event.type==='append'?'upsert_append':'upsert_other');
    // No application consumer, message-body access, draft creation or registration.
  });
  const blocked=async()=>{diagnostic(sink,'sync_application_send_blocked');throw new Error('Synchronization-only application sends disabled.');};
  socket.sendMessage=blocked;socket.relayMessage=blocked;
  return {socket,async drainKeys(){while(pending.size)await Promise.allSettled([...pending]);}};
}
