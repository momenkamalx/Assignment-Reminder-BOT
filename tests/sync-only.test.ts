import {EventEmitter} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import type {AuthenticationState} from '@whiskeysockets/baileys';
import {synchronizationSocket} from '../src/pilot/sync-socket.js';
import {observeSynchronization} from '../src/pilot/sync-runtime.js';
import type {DiagnosticEvent} from '../src/diagnostics.js';
const factory=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('@whiskeysockets/baileys',async original=>({...await original<typeof import('@whiskeysockets/baileys')>(),default:factory.create}));
afterEach(()=>{vi.useRealTimers();factory.create.mockReset();});
const group='120363000000000001@g.us',self='249900000001@s.whatsapp.net';
const auth=()=>({creds:{},keys:{get:vi.fn(async()=>({})),set:vi.fn(async()=>{})}} as unknown as AuthenticationState);
it('keeps native message/notification/receipt/pending handlers and blocks every exported application send',async()=>{
 const ev=new EventEmitter(),ws=new EventEmitter();const native={message:vi.fn(),notification:vi.fn(),receipt:vi.fn(),offline:vi.fn()};
 ws.on('CB:message',native.message);ws.on('CB:notification',native.notification);ws.on('CB:receipt',native.receipt);ws.on('CB:ib,,offline',native.offline);ws.on('CB:ib,,dirty',vi.fn());
 const events:DiagnosticEvent[]=[];const send=vi.fn();factory.create.mockReturnValue({ev,ws,sendMessage:send,relayMessage:send});
 const {socket}=synchronizationSocket(auth(),group,e=>events.push(e));
 ws.emit('CB:message',{attrs:{from:group,offline:'0'},get content(){throw Error('Private content accessed');}});ws.emit('CB:notification',{});ws.emit('CB:receipt',{});ws.emit('CB:ib,,offline',{});
 for(const fn of Object.values(native))expect(fn).toHaveBeenCalledOnce();expect(ws.listenerCount('CB:ib,,dirty')).toBe(0);
 await expect(socket.sendMessage(group,{text:'blocked'})).rejects.toThrow();await expect(socket.relayMessage(group,{},{})).rejects.toThrow();expect(send).not.toHaveBeenCalled();
 const config=factory.create.mock.calls[0]![0];expect(config.shouldIgnoreJid(group)).toBe(false);expect(config.shouldIgnoreJid(self)).toBe(true);expect(config.shouldSyncHistoryMessage({})).toBe(false);
 expect(events.some(e=>e.code==='offline_flag_zero')).toBe(true);expect(JSON.stringify(events)).not.toContain(group);
});
it('redacts SDK arguments before serialization while counting native ack/receipt/batch attempts',()=>{
 const ev=new EventEmitter(),ws=new EventEmitter();factory.create.mockReturnValue({ev,ws,sendMessage:vi.fn()});const events:DiagnosticEvent[]=[];
 synchronizationSocket(auth(),group,e=>events.push(e));const logger=factory.create.mock.calls[0]![0].logger;
 const privateObject={recv:{tag:'notification',get attrs(){throw Error('Serialized private identifiers');}},get credentials(){throw Error('Serialized credentials');}};
 logger.debug(privateObject,'sent ack');logger.debug({get attrs(){throw Error('Serialized receipt');}},'sending receipt for messages');
 logger.info('offline preview received','PRIVATE_RAW_FRAME');logger.warn({get error(){throw Error('Serialized error');}},'failed to send initial passive iq');
 const codes=events.map(e=>e.code);for(const code of ['protocol_ack_attempt','protocol_notification_ack_attempt','protocol_receipt_attempt','offline_batch_request_attempt','sdk_activation_warning'])expect(codes).toContain(code);
 expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
it('persists native key writes through the existing store without altering values',async()=>{
 const ev=new EventEmitter(),ws=new EventEmitter();factory.create.mockReturnValue({ev,ws,sendMessage:vi.fn()});const events:DiagnosticEvent[]=[];const state=auth();
 const active=synchronizationSocket(state,group,e=>events.push(e));const observed=factory.create.mock.calls[0]![0].auth;
 const data={session:{test:Buffer.from([1,2,3])}};await observed.keys.set(data);await active.drainKeys();
 expect(state.keys.set).toHaveBeenCalledWith(data);expect(observed.creds).toBe(state.creds);expect(events.map(e=>e.code)).toEqual(['signal_write_attempt','signal_write_ok']);
});
function runtime(){
 const ev=Object.assign(new EventEmitter(),{isBuffering:()=>true}),ws=Object.assign(new EventEmitter(),{isOpen:true});const events:DiagnosticEvent[]=[];
 const socket={ev,ws,user:{id:self},end:vi.fn(()=>{ws.isOpen=false;ev.emit('connection.update',{connection:'close'});})};
 const create=vi.fn(()=>({socket:socket as unknown as ReturnType<typeof synchronizationSocket>['socket'],drainKeys:vi.fn(async()=>{})}));const save=vi.fn(async()=>{}),state=vi.fn();
 const run=(signal?:AbortSignal)=>observeSynchronization({auth:auth(),saveCreds:save,expectedAccount:self,create,sink:e=>events.push(e),state,signal});
 return {ev,ws,socket,events,create,save,state,run};
}
it('observes real pending transitions, waits for persistence, closes once and never reconnects',async()=>{
 vi.useFakeTimers();const h=runtime();const task=h.run();h.ev.emit('connection.update',{connection:'connecting',receivedPendingNotifications:false});
 h.ev.emit('connection.update',{connection:'open'});h.ev.emit('creds.update',{});await vi.advanceTimersByTimeAsync(250);
 h.ev.isBuffering=()=>false;h.ev.emit('connection.update',{receivedPendingNotifications:true});await vi.advanceTimersByTimeAsync(3100);await task;
 expect(h.create).toHaveBeenCalledOnce();expect(h.socket.end).toHaveBeenCalledOnce();expect(h.save).toHaveBeenCalledOnce();
 expect(h.events.map(e=>e.code)).toContain('sync_pending_true');expect(h.events.map(e=>e.code)).toContain('credentials_save_ok');expect(h.events.map(e=>e.code)).not.toContain('sync_unexpected_close');
 expect(h.state.mock.calls.at(-1)![0]).toMatchObject({websocketOpen:false,pendingNotifications:true,accountVerified:true,eventBuffering:false});
});
it('keeps completion unobserved after buffer release and stops on the bounded time limit',async()=>{
 vi.useFakeTimers();const h=runtime();const task=h.run();h.ev.emit('connection.update',{connection:'open'});h.ev.isBuffering=()=>false;
 await vi.advanceTimersByTimeAsync(180000);await task;expect(h.events.map(e=>e.code)).not.toContain('sync_pending_true');expect(h.events.map(e=>e.code)).toContain('sync_duration_elapsed');expect(h.create).toHaveBeenCalledOnce();
});
it('stops on account mismatch or unexpected disconnection without another connection',async()=>{
 const h=runtime();const task=h.run();h.ev.emit('connection.update',{connection:'close'});await task;
 expect(h.events.map(e=>e.code)).toContain('sync_unexpected_close');expect(h.create).toHaveBeenCalledOnce();
});
it('closes immediately if the connected account differs from the expected spare account',async()=>{
 const h=runtime();h.socket.user.id='249900000099@s.whatsapp.net';const task=h.run();h.ev.emit('connection.update',{connection:'open'});await task;
 expect(h.events.map(e=>e.code)).toContain('sdk_error');expect(h.events.map(e=>e.code)).not.toContain('sync_account_verified');expect(h.socket.end).toHaveBeenCalledOnce();expect(h.create).toHaveBeenCalledOnce();
});
it('handles operator cancellation gracefully without logout or reconnect',async()=>{
 const h=runtime();const abort=new AbortController();const task=h.run(abort.signal);abort.abort();await task;
 expect(h.socket.end).toHaveBeenCalledOnce();expect(h.create).toHaveBeenCalledOnce();expect(h.events.map(e=>e.code)).toContain('sync_finished');
});
it('starts the strict three-minute window at transport open, not creation or SDK authentication',async()=>{
 vi.useFakeTimers();const h=runtime();h.ws.isOpen=false;const task=h.run();
 await vi.advanceTimersByTimeAsync(20000);expect(h.socket.end).not.toHaveBeenCalled();
 h.ws.isOpen=true;h.ws.emit('open');
 await vi.advanceTimersByTimeAsync(120000);h.ws.emit('open');h.ev.emit('connection.update',{connection:'open'});
 await vi.advanceTimersByTimeAsync(59999);expect(h.socket.end).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);await task;
 expect(h.socket.end).toHaveBeenCalledOnce();expect(h.create).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 expect(h.ws.listenerCount('open')).toBe(0);expect(h.ev.listenerCount('connection.update')).toBe(0);expect(h.ev.listenerCount('creds.update')).toBe(0);
});
it('stops immediately on completion just before the deadline and cannot rearm after shutdown',async()=>{
 vi.useFakeTimers();const h=runtime();const task=h.run();h.ev.emit('connection.update',{connection:'open'});
 await vi.advanceTimersByTimeAsync(179999);h.ev.emit('connection.update',{receivedPendingNotifications:true});await task;
 expect(h.socket.end).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 h.ws.emit('open');h.ev.emit('connection.update',{receivedPendingNotifications:true});await vi.advanceTimersByTimeAsync(180000);
 expect(h.events.map(e=>e.code)).not.toContain('sync_duration_elapsed');expect(h.socket.end).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('exits automatically if the transport never opens, without retrying',async()=>{
 vi.useFakeTimers();const h=runtime();h.ws.isOpen=false;const task=h.run();
 await vi.advanceTimersByTimeAsync(60000);await task;
 expect(h.events.map(e=>e.code)).toContain('sync_connection_timeout');expect(h.events.map(e=>e.code)).not.toContain('sync_duration_elapsed');
 expect(h.socket.end).toHaveBeenCalledOnce();expect(h.create).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('cleans timers and diagnostic listeners even when closing the transport fails',async()=>{
 vi.useFakeTimers();const h=runtime();h.socket.end.mockImplementation(()=>{throw Error('close failed');});
 const abort=new AbortController();const task=h.run(abort.signal);const rejected=expect(task).rejects.toThrow('close failed');abort.abort();await rejected;
 expect(h.create.mock.results[0]!.value.drainKeys).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 expect(h.ws.listenerCount('open')).toBe(0);expect(h.ev.listenerCount('connection.update')).toBe(0);expect(h.ev.listenerCount('creds.update')).toBe(0);
});
