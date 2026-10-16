import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import pino from 'pino';
import {useMultiFileAuthState} from '@whiskeysockets/baileys';
import {makeEventBuffer} from '@whiskeysockets/baileys/lib/Utils/event-buffer.js';
import {observeSdkLog} from '../src/pilot/sdk-diagnostics.js';
import {readyForIncoming} from '../src/pilot/readiness.js';
import type {DiagnosticEvent} from '../src/diagnostics.js';

const folders:string[]=[];
afterEach(async()=>{vi.useRealTimers();for(const path of folders.splice(0))await rm(path,{recursive:true,force:true});});
it.each([
 ['DISABLING ALL SYNC BY shouldSyncHistoryMsg','sdk_sync_disabled'],
 ['Buffer timeout reached, auto-flushing','sdk_buffer_timeout'],
 ['failed to send initial passive iq','sdk_activation_warning'],
 ['failed to run digest after login','sdk_digest_warning'],
 ['Failed to check/upload pre-keys during initialization','sdk_prekey_warning'],
 ['no name present, ignoring presence update request...','sdk_presence_warning'],
 ['Failed to store LID-PN mapping','sdk_lid_warning'],
 ['failed to commit mutations, retries left=8','sdk_key_commit_warning'],
 ['PRIVATE UNKNOWN WARNING','sdk_warning_unclassified'],
])('maps SDK warning to fixed category %s', (msg,code)=>{
 const events:DiagnosticEvent[]=[];observeSdkLog(JSON.stringify({level:40,msg,credentials:'PRIVATE_CREDENTIAL',jid:'PRIVATE_IDENTIFIER',error:{stack:'PRIVATE_STACK'}}),e=>events.push(e));
 expect(events).toEqual([{code:'sdk_warning',count:1},{code,count:1}]);expect(JSON.stringify(events)).not.toContain('PRIVATE');
});
it('malformed SDK logs expose neither raw text nor exception contents',()=>{
 const events:DiagnosticEvent[]=[];observeSdkLog('PRIVATE_NON_JSON',e=>events.push(e));expect(events).toEqual([{code:'sdk_error',count:1}]);
});
it('installed rc14 buffer timeout clears buffering without emitting pending completion or allowing readiness',async()=>{
 vi.useFakeTimers();const events:DiagnosticEvent[]=[];const logger=pino({level:'warn'},{write:line=>observeSdkLog(line,e=>events.push(e))});
 const ev=makeEventBuffer(logger);const completions:boolean[]=[];ev.on('connection.update',event=>{if(event.receivedPendingNotifications===true)completions.push(true);});
 ev.buffer();expect(ev.isBuffering()).toBe(true);await vi.advanceTimersByTimeAsync(30000);
 expect(ev.isBuffering()).toBe(false);expect(completions).toHaveLength(0);expect(events.some(e=>e.code==='sdk_buffer_timeout')).toBe(true);
 expect(readyForIncoming({connectionOpen:true,identityVerified:true,listenerAttached:true,pendingNotificationsReady:false},{websocketOpen:true,sameTransport:true,routeAttached:true,sdkHandlers:1,eventBuffering:ev.isBuffering()})).toBe(false);ev.destroy();
});
it('persists synthetic Signal keys without a creds.update event and serializes credentials separately',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'pending-sync-auth-test-'));folders.push(folder);
 const auth=await useMultiFileAuthState(folder);await auth.state.keys.set({session:{'test-session':Buffer.from([1,2,3])}});
 const reloaded=await useMultiFileAuthState(folder);const keys=await reloaded.state.keys.get('session',['test-session']);expect(Buffer.from(keys['test-session']!).equals(Buffer.from([1,2,3]))).toBe(true);
 auth.state.creds.accountSyncCounter=7;await auth.saveCreds();const saved=await useMultiFileAuthState(folder);expect(saved.state.creds.accountSyncCounter).toBe(7);
 expect(Buffer.from((await saved.state.keys.get('session',['test-session']))['test-session']!).equals(Buffer.from([1,2,3]))).toBe(true);
});
it('documents SDK null-on-corrupt-key behavior using only a temporary synthetic store',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'pending-sync-corrupt-test-'));folders.push(folder);
 const auth=await useMultiFileAuthState(folder);await writeFile(join(folder,'session-test-session.json'),'invalid synthetic JSON');
 const keys=await auth.state.keys.get('session',['test-session']);expect(keys['test-session']).toBeNull();
});
