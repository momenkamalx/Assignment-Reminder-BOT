import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticationState, BaileysEventMap, BinaryNode, WAMessage } from '@whiskeysockets/baileys';
import { Store } from '../src/database.js';
import { applyGroups } from '../src/whatsapp/config.js';
import { ControlledTest } from '../src/pilot/controlled.js';
import { controlledSocket } from '../src/pilot/controlled-socket.js';
import { receivePipelineStatus } from '../src/pilot/controlled-socket.js';
import { readyForIncoming, attachIncomingListener } from '../src/pilot/readiness.js';
import { makeEventBuffer } from '@whiskeysockets/baileys/lib/Utils/event-buffer.js';
import pino from 'pino';
import type { DiagnosticEvent } from '../src/diagnostics.js';
import { controlledPermissions } from '../src/pilot/permissions.js';

const factory=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@whiskeysockets/baileys',async original=>({...await original<typeof import('@whiskeysockets/baileys')>(),default:factory.create}));
const group={id:'120363000000000001@g.us',leader:'249900000001@s.whatsapp.net',admins:['249900000002@s.whatsapp.net'],timezone:'Africa/Khartoum',reminders:{offsetHours:[24],mentions:'none' as const}};
const self='249900000003@s.whatsapp.net',lid='100000000001@lid';
const text='Course: Networks\nAssignment\nName: Diagnostic test\nDue: 2027-05-20 23:25\nSubmission: SUST Moodle';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0))await cleanup();factory.create.mockReset();});
function harness(withHandler=true,diagnosticOnly=false){
  const dir=mkdtempSync(join(tmpdir(),'incoming-diagnostics-'));const store=new Store(join(dir,'test.sqlite'));applyGroups(store,[group]);
  const events:DiagnosticEvent[]=[];const tasks:Promise<void>[]=[];const now=()=> '2026-10-15T18:00:00.000Z';
  const controller=new ControlledTest(store,group,new Map([[group.leader,group.leader],[lid,group.leader],[group.admins[0]!,group.admins[0]!]]),()=>{},()=>{},now,{diagnosticOnly,diagnostics:e=>events.push(e)});
  const ev=Object.assign(new EventEmitter(),{isBuffering:()=>false}),ws=Object.assign(new EventEmitter(),{isOpen:true});
  const pendingHandlers={preview:vi.fn(),complete:vi.fn()};
  ws.on('CB:ib,,offline_preview',pendingHandlers.preview);ws.on('CB:ib,,offline',pendingHandlers.complete);
  const lifecycle={connection:vi.fn(),credentials:vi.fn(),lid:vi.fn()};
  ev.on('connection.update',lifecycle.connection);ev.on('creds.update',lifecycle.credentials);ev.on('lid-mapping.update',lifecycle.lid);
  let message:WAMessage={key:{remoteJid:group.id,id:'source-1',participant:group.leader,fromMe:false},message:{conversation:text},messageTimestamp:1792087200};
  const original=vi.fn(()=>ev.emit('messages.upsert',{type:'notify',messages:[message]}));if(withHandler)ws.on('CB:message',original);
  const send=vi.fn(async(jid:string,_content:unknown,options:{messageId:string})=>{
    ws.emit('CB:ack,class:message',{tag:'ack',attrs:{class:'message',id:options.messageId,from:jid}});
    return {key:{id:options.messageId,remoteJid:jid,fromMe:true}};
  });
  factory.create.mockReturnValue({ev,ws,sendMessage:send,user:{id:self}});
  const socket=controlledSocket({creds:{}} as AuthenticationState,group.id,e=>controller.observe(e));
  ev.on('messages.upsert',(event:BaileysEventMap['messages.upsert'])=>tasks.push(controller.receive(event)));
  controller.observe({code:'listener_registered',count:1});controller.start(socket);
  cleanups.push(async()=>{await controller.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  const flush=async()=>{await Promise.all(tasks.splice(0));};
  const emit=async(node:unknown={tag:'message',attrs:{from:group.id}})=>{ws.emit('CB:message',node);await flush();};
  const count=(code:string)=>events.filter(e=>e.code===code).reduce((n,e)=>n+e.count,0);
  return {store,controller,events,ev,ws,socket,lifecycle,pendingHandlers,original,send,emit,flush,count,set:(next:WAMessage)=>{message=next;},raw:()=>message};
}
it.each(['phone','lid'])('traces a new %s leader message from raw transport through one acknowledged preview and registration',async mode=>{
  const h=harness();if(mode==='lid')h.set({...h.raw(),key:{...h.raw().key,participant:lid}});
  expect(h.ev.listenerCount('messages.upsert')).toBe(1);await h.emit();await h.emit();
  for(const code of ['transport_message_received','raw_group_message','sdk_handler_forwarded','upsert_notify','pilot_group_matched','sender_resolved','pilot_leader_matched','pilot_parser_invoked','group_matched','parser_invoked','draft_created','preview_queued','outgoing_attempted','outgoing_acknowledged'])expect(h.count(code)).toBeGreaterThan(0);
  expect(h.send).toHaveBeenCalledTimes(1);expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM confirmations').get()!.n).toBe(1);
  const id=h.store.db.prepare('SELECT message_id FROM confirmations').get()!.message_id as string;
  h.set({key:{remoteJid:group.id,id:'approval-1',participant:group.admins[0],fromMe:false},message:{extendedTextMessage:{text:'نعم',contextInfo:{stanzaId:id,participant:self,remoteJid:group.id}}}});
  await h.emit();await h.emit();expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(1);expect(h.send).toHaveBeenCalledTimes(2);
});
it('diagnostic mode permits a preview/correction but never approval, registration, list or reminders',async()=>{
  const h=harness(true,true);await h.emit();const preview=h.store.db.prepare('SELECT message_id FROM confirmations').get()!.message_id as string;
  const reply=(body:string,id:string,quote=preview)=>({key:{remoteJid:group.id,id,participant:group.admins[0],fromMe:false},message:{extendedTextMessage:{text:body,contextInfo:{stanzaId:quote,participant:self,remoteJid:group.id}}}} as WAMessage);
  for(const body of ['نعم','yes','لا','!list']){h.set(reply(body,body));await h.emit();}
  expect(h.send).toHaveBeenCalledTimes(1);expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(0);
  h.set(reply('!edit 1 name=Corrected diagnostic title','edit-1'));await h.emit();expect(h.send).toHaveBeenCalledTimes(2);
  const updated=h.store.db.prepare("SELECT message_id FROM confirmations WHERE status='pending'").get()!.message_id as string;
  h.set(reply('نعم','approval-current',updated));await h.emit();await h.controller.tick();
  expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(0);expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM reminder_jobs').get()!.n).toBe(0);
  expect(h.controller.state.overrideEnabled).toBe(false);expect(h.send).toHaveBeenCalledTimes(2);
});
it('requires explicit diagnostic approval and refuses reminder permissions in diagnostic mode',()=>{
  const env={PILOT_CONTROLLED_TEST:'true',PILOT_CORRECTIONS_APPROVED:'true',PILOT_DIAGNOSTIC_ONLY:'true',PILOT_DIAGNOSTIC_APPROVED:'true'};
  expect(controlledPermissions(env)).toEqual({diagnosticOnly:true});
  expect(()=>controlledPermissions({...env,PILOT_DIAGNOSTIC_APPROVED:'false'})).toThrow();
  expect(()=>controlledPermissions({...env,PILOT_REMINDER_TEST:'true'})).toThrow();
  expect(()=>controlledPermissions({...env,PILOT_DIAGNOSTIC_ONLY:'false'})).toThrow();
});
it('keeps all 73 startup offline messages ignored, and rejects append even with a current timestamp',async()=>{
  const h=harness();for(let i=0;i<73;i++)await h.emit({tag:'message',attrs:{from:group.id,offline:'1'}});
  expect(h.count('offline_message_rejected')).toBe(73);expect(h.original).not.toHaveBeenCalled();expect(h.count('upsert_received')).toBe(0);
  h.ev.emit('messages.upsert',{type:'append',messages:[h.raw()]});await h.flush();
  expect(h.count('upsert_append')).toBe(1);expect(h.count('pilot_parser_invoked')).toBe(0);expect(h.send).not.toHaveBeenCalled();
});
it('counts early routing rejects without accessing unrelated bodies or logging identifiers',async()=>{
  const h=harness();for(const from of ['120363000000000099@g.us','249900000099@s.whatsapp.net'])await h.emit({attrs:{from},get content(){throw Error('Private body accessed');}});
  await h.emit({attrs:{}});expect(h.count('transport_message_received')).toBe(3);expect(h.count('transport_route_rejected')).toBe(2);expect(h.count('transport_key_invalid')).toBe(1);expect(h.original).not.toHaveBeenCalled();
  const raw=h.raw();h.ev.emit('messages.upsert',{type:'notify',messages:[{...raw,key:{...raw.key,remoteJid:'120363000000000099@g.us'}}]});await h.flush();expect(h.count('group_rejected')).toBe(1);expect(h.send).not.toHaveBeenCalled();
  const serialized=JSON.stringify(h.events);for(const secret of [text,group.id,group.leader,lid,'249900000099','source-1'])expect(serialized.includes(secret)).toBe(false);
  for(const event of h.events){expect(Object.keys(event).sort()).toEqual(['code','count']);expect(Number.isSafeInteger(event.count)).toBe(true);}
});
it.each([
  {},{key:null},{key:{remoteJid:123}},{key:{remoteJid:group.id,id:42,participant:group.leader}},
  {key:{remoteJid:group.id,id:'missing-participant'}},{key:{remoteJid:group.id,id:'invalid-alias',participant:group.leader,participantAlt:42}},
])('diagnoses malformed keys without creating drafts or failing the pilot: %j',async raw=>{
  const h=harness();h.set(raw as unknown as WAMessage);await h.emit();
  expect(h.count('message_key_invalid')).toBe(1);expect(h.count('pilot_parser_invoked')).toBe(0);expect(h.send).not.toHaveBeenCalled();
  await h.controller.adapter.receive({type:'notify',messages:[raw as unknown as WAMessage]});expect(h.count('message_key_invalid')).toBe(2);
});
it('identifies self-sent, unknown and conflicting sender rejections before parser entry',async()=>{
  const h=harness();const raw=h.raw();
  for(const key of [{...raw.key,fromMe:true},{...raw.key,participant:'249900000099@s.whatsapp.net'},{...raw.key,participantAlt:group.admins[0]}]){h.set({...raw,key});await h.emit();}
  expect(h.count('self_message_rejected')).toBe(1);expect(h.count('sender_unresolved')).toBe(1);expect(h.count('sender_conflict')).toBe(1);expect(h.count('pilot_parser_invoked')).toBe(0);expect(h.send).not.toHaveBeenCalled();
});
it('reports SDK-handler absence, unexpected update/history paths, and handler errors without payloads',async()=>{
  const h=harness(false);await h.emit();expect(h.count('sdk_handler_missing')).toBe(1);expect(h.count('sdk_handler_forwarded')).toBe(0);
  const privatePayload={get messages(){throw Error('History content accessed');}};
  h.ev.emit('messages.update',privatePayload);h.ev.emit('messaging-history.set',privatePayload);
  expect(h.count('message_update_received')).toBe(1);expect(h.count('history_event_received')).toBe(1);expect(h.send).not.toHaveBeenCalled();
  const failed=harness();failed.original.mockImplementation(()=>{throw Error('PRIVATE ERROR CONTENT');});await failed.emit();
  expect(failed.count('receive_failed')).toBe(1);expect(JSON.stringify(failed.events)).not.toContain('PRIVATE ERROR CONTENT');
});
it.each([[undefined,'timestamp_missing'],[NaN,'timestamp_invalid'],[1792087100,'timestamp_before_start'],[1792087200,'timestamp_since_start']])('classifies timestamps without logging their values or accepting history: %s',async(timestamp,code)=>{
  const h=harness();h.set({...h.raw(),messageTimestamp:timestamp as number});await h.emit();expect(h.count(code as string)).toBe(1);
  expect(h.send).toHaveBeenCalledTimes(1); // Timestamp diagnostics do not change existing notify policy.
});
it('preserves SDK lifecycle and phone/LID synchronization listeners',()=>{
  const h=harness();h.ev.emit('connection.update',{connection:'open'});h.ev.emit('connection.update',{receivedPendingNotifications:true});
  h.ev.emit('creds.update',{});h.ev.emit('lid-mapping.update',{lid, pn:group.leader});
  expect(h.lifecycle.connection).toHaveBeenCalledTimes(2);expect(h.lifecycle.credentials).toHaveBeenCalledOnce();expect(h.lifecycle.lid).toHaveBeenCalledOnce();
  expect(h.ws.listenerCount('CB:message')).toBe(1);
});
const readyState={connectionOpen:true,pendingNotificationsReady:true,identityVerified:true,listenerAttached:true};
it.each(['connectionOpen','pendingNotificationsReady','identityVerified','listenerAttached'] as const)('refuses readiness when %s has not been established',field=>{
  const h=harness();expect(readyForIncoming(readyState,receivePipelineStatus(h.socket))).toBe(true);
  expect(readyForIncoming({...readyState,[field]:false},receivePipelineStatus(h.socket))).toBe(false);
});
it('refuses readiness for closed sockets, buffered events or missing SDK handlers',()=>{
  const h=harness();h.ws.isOpen=false;expect(readyForIncoming(readyState,receivePipelineStatus(h.socket))).toBe(false);
  h.ws.isOpen=true;h.ev.isBuffering=()=>true;expect(readyForIncoming(readyState,receivePipelineStatus(h.socket))).toBe(false);
  h.ev.isBuffering=()=>false;expect(readyForIncoming(readyState,receivePipelineStatus(h.socket))).toBe(true);
  const empty=harness(false);expect(readyForIncoming(readyState,receivePipelineStatus(empty.socket))).toBe(false);
});
it('detects removed handlers or an obsolete/replaced transport instance',()=>{
  const h=harness();h.ws.removeAllListeners('CB:message');expect(receivePipelineStatus(h.socket).routeAttached).toBe(false);
  expect(readyForIncoming(readyState,receivePipelineStatus(h.socket))).toBe(false);
  const replaced={...h.socket,ws:Object.assign(new EventEmitter(),{isOpen:true})};
  expect(receivePipelineStatus(replaced as typeof h.socket).sameTransport).toBe(false);
  expect(readyForIncoming(readyState,receivePipelineStatus(replaced as typeof h.socket))).toBe(false);
});
it('observes wire, decoded-frame and alternate notification paths using codes only',()=>{
  const h=harness();h.ws.emit('message',Buffer.from('PRIVATE_WIRE_CONTENT'));
  h.ws.emit('frame',{tag:'message',get attrs(){throw Error('Do not inspect identifiers');}});
  h.ws.emit('frame',{tag:'notification',get content(){throw Error('Do not inspect body');}});
  h.ws.emit('frame',{tag:'PRIVATE_TAG'});h.ws.emit('frame',new Uint8Array([1,2]));
  expect(h.count('wire_payload_received')).toBe(1);expect(h.count('decoded_frame_received')).toBe(4);
  expect(h.count('decoded_message_frame')).toBe(1);expect(h.count('decoded_notification_frame')).toBe(1);expect(h.count('decoded_other_frame')).toBe(2);
  expect(JSON.stringify(h.events)).not.toContain('PRIVATE');expect(h.send).not.toHaveBeenCalled();
});
it('counts SDK warnings/errors without exposing their private log payloads',()=>{
  const h=harness();const logger=factory.create.mock.calls.at(-1)![0].logger;
  logger.warn({credential:'PRIVATE_CREDENTIAL'},'PRIVATE_WARNING');logger.error({jid:group.id},'PRIVATE_ERROR');
  expect(h.count('sdk_warning')).toBe(1);expect(h.count('sdk_error')).toBe(1);
  expect(JSON.stringify(h.events)).not.toContain('PRIVATE');expect(JSON.stringify(h.events)).not.toContain(group.id);
});
it('installed SDK event buffer delays upserts until flush; ev.process does not consume named events',()=>{
  const ev=makeEventBuffer(pino({level:'silent'}));const named=vi.fn(),batch=vi.fn();
  ev.on('messages.upsert',named);ev.process(batch);ev.buffer();
  ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'BUFFERED',remoteJid:group.id},message:{conversation:'PRIVATE_CONTENT'}}]});
  expect(ev.isBuffering()).toBe(true);expect(named).not.toHaveBeenCalled();expect(batch).not.toHaveBeenCalled();
  ev.flush();expect(ev.isBuffering()).toBe(false);expect(named).toHaveBeenCalledOnce();expect(batch).toHaveBeenCalledOnce();ev.destroy();
});
it('verifies actual installed-SDK upsert listener attachment, removal and event-emitter replacement',()=>{
  const ev=makeEventBuffer(pino({level:'silent'}));const socket={ev} as unknown as ReturnType<typeof controlledSocket>;
  const handler=vi.fn();const attached=attachIncomingListener(socket,handler);expect(attached()).toBe(true);
  ev.off('messages.upsert',handler);expect(attached()).toBe(false);
  ev.on('messages.upsert',handler);expect(attached()).toBe(true);
  const replacement=makeEventBuffer(pino({level:'silent'}));socket.ev=replacement;expect(attached()).toBe(false);
  ev.destroy();replacement.destroy();
});
it('distinguishes decoded offline markers from SDK dispatch without removing original callbacks',()=>{
  const h=harness();const child=(tag:string)=>({tag,get attrs(){throw Error('Private protocol attributes read');},get content(){throw Error('Private protocol body read');}});
  h.ws.emit('frame',{tag:'ib',content:[child('offline_preview')]});h.ws.emit('frame',{tag:'ib',content:[child('other'),child('offline')]});
  expect(h.count('pending_offline_preview_frame')).toBe(1);expect(h.count('pending_offline_marker_frame')).toBe(1);
  expect(h.count('pending_offline_marker_callback')).toBe(0);
  h.ws.emit('CB:ib,,offline_preview',{});h.ws.emit('CB:ib,,offline',{});
  expect(h.pendingHandlers.preview).toHaveBeenCalledOnce();expect(h.pendingHandlers.complete).toHaveBeenCalledOnce();
  expect(h.count('pending_offline_preview_callback')).toBe(1);expect(h.count('pending_offline_marker_callback')).toBe(1);
  expect(h.send).not.toHaveBeenCalled();expect(h.original).not.toHaveBeenCalled();
});
it('counts offline zero separately but keeps zero, one and unknown flags blocked pending protocol review',async()=>{
  const h=harness();for(const offline of ['0','1','unknown'])await h.emit({attrs:{from:group.id,offline}});
  expect(h.count('offline_flag_zero')).toBe(1);expect(h.count('offline_flag_one')).toBe(1);expect(h.count('offline_flag_other')).toBe(1);
  expect(h.count('offline_message_rejected')).toBe(3);expect(h.original).not.toHaveBeenCalled();expect(h.send).not.toHaveBeenCalled();
  await h.emit();expect(h.count('offline_flag_absent')).toBe(1);expect(h.original).toHaveBeenCalledOnce();
});
