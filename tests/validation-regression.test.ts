import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { Store } from '../src/database.js';
import { Bot } from '../src/bot.js';
import { MockWhatsAppAdapter } from '../src/mock-adapter.js';
import { applyGroups } from '../src/whatsapp/config.js';
import type { Socket } from '../src/whatsapp/adapter.js';
import { ControlledTest, type ControlledOptions } from '../src/pilot/controlled.js';
import { acceptsPilotDrafts } from '../src/pilot/validation.js';
import { extractAssignments } from '../src/parser.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import { diagnostic, type DiagnosticEvent } from '../src/diagnostics.js';
import { sudaneseAnnouncement, expectedAssignments } from './fixtures/sudanese-announcement.js';

const group = { id: '120363000000000001@g.us', leader: '249900000001@s.whatsapp.net', admins: ['249900000002@s.whatsapp.net','249900000003@s.whatsapp.net'], timezone: 'Africa/Khartoum', reminders: { offsetHours: [24], mentions: 'none' as const } };
const self = '249900000004@s.whatsapp.net';
const valid = 'Course: Networks\nAssignment\nName: Worksheet\nDue: 2027-05-20 18:00\nSubmission: SUST Moodle';
const folders: string[] = [];
const open = new Set<Store>();
const controls = new Set<ControlledTest>();
afterEach(async () => {
  for (const control of controls) await control.stop(); controls.clear();
  for (const store of open) store.close(); open.clear();
  folders.splice(0).forEach(path => rmSync(path,{recursive:true,force:true}));
});
function fixture(options: ControlledOptions = {}, prior?: { path: string; mock: MockWhatsAppAdapter; clock: { value: string } }) {
  const directory = prior ? undefined : mkdtempSync(join(tmpdir(),'assignment-validation-'));
  if (directory) folders.push(directory);
  const path = prior?.path ?? join(directory!,'test.sqlite');
  const store = new Store(path); open.add(store);
  if (!prior) applyGroups(store,[group]);
  const mock = prior?.mock ?? new MockWhatsAppAdapter();
  const clock = prior?.clock ?? { value:'2026-10-15T18:00:00.000Z' };
  const diagnostics: DiagnosticEvent[] = [];
  const aliases = new Map([group.leader,...group.admins].map(id=>[id,id]));
  aliases.set('100000000001@lid',group.leader);
  let serial=0, attempts=0, fail=false;
  const socket = { ev:new EventEmitter(),user:{id:self},end:()=>{},sendMessage:async(jid:string,content:{text:string;mentions?:string[];mentionAll?:boolean},sendOptions:{messageId:string;quoted?:WAMessage})=>{
    attempts++; if(fail)throw new Error('Simulated uncertain transport');
    await mock.send(jid,content.text,sendOptions.quoted?.key.id??undefined,{messageId:sendOptions.messageId,...(content.mentions?{mentions:content.mentions}:{}),...(content.mentionAll?{mentionAll:true}:{})});
    return {key:{id:sendOptions.messageId,remoteJid:jid,fromMe:true}};
  }};
  const control=new ControlledTest(store,group,aliases,()=>{},()=>{},()=>clock.value,{...options,diagnostics:event=>diagnostics.push(event)}); controls.add(control);control.start(socket as unknown as Socket);
  const raw=(text:string,sender=group.leader,quote?:string,chat=group.id,author=self):WAMessage=>({key:{id:`incoming-${crypto.randomUUID()}-${++serial}`,remoteJid:chat,participant:sender,fromMe:false},message:quote?{extendedTextMessage:{text,contextInfo:{stanzaId:quote,participant:author,remoteJid:chat}}}:{conversation:text}});
  const send=(text:string,sender=group.leader,quote?:string,chat=group.id,author=self)=>control.receive({type:'notify',messages:[raw(text,sender,quote,chat,author)]});
  const count=(table:string)=>Number(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const last=()=>mock.sent.at(-1)!;
  const crash=()=>{controls.delete(control);open.delete(store);store.close();};
  return {path,store,mock,clock,control,diagnostics,send,raw,count,last,crash,attempts:()=>attempts,fail:()=>{fail=true;},advance:(ms:number)=>{clock.value=new Date(Date.parse(clock.value)+ms).toISOString();}};
}
const localOriginal=resolve('data/pilot/original-announcement.txt');
it.skipIf(!existsSync(localOriginal))('the exact unchanged local original now creates a private correction preview (no content in assertions)',async()=>{
  const original=readFileSync(localOriginal);const h=fixture();
  await h.send(original.toString('utf8'),'100000000001@lid');
  expect(h.count('confirmations')).toBe(1);expect(h.mock.sent.length).toBe(1);
  expect(h.last().text.includes('يحتاج توضيح')).toBe(true);
  expect(h.last().text.includes('!edit')).toBe(true);
  expect(h.count('assignments')).toBe(0);expect(h.count('reminder_jobs')).toBe(0);
  await h.send('نعم',group.admins[0],h.last().id);
  expect(h.count('assignments')).toBe(0);expect(h.count('reminder_jobs')).toBe(0);
  expect(readFileSync(localOriginal).equals(original)).toBe(true);
  for(const event of h.diagnostics){expect(Object.keys(event).sort()).toEqual(['code','count']);expect(typeof event.count).toBe('number');}
});
it.each([
  ['missing subject',valid.replace('Course: Networks\n',''),'course'],
  ['missing title',valid.replace('Name: Worksheet\n',''),'name'],
  ['Sudanese ambiguous deadline','يا شباب عندنا واجب، التسليم بكرة مساءً على Moodle','deadline'],
  ['unrecognized date',valid.replace('2027-05-20 18:00','20/05/27 evening'),'deadline'],
  ['missing destination',valid.replace('\nSubmission: SUST Moodle',''),'submissionMethod'],
  ['bare assigned item','Assignment','deadline'],
])('retains %s as an editable draft without inventing fields',async(_label,text,field)=>{
  const h=fixture();await h.send(text);
  expect(h.count('confirmations')).toBe(1);expect(h.count('assignments')).toBe(0);expect(h.count('reminder_jobs')).toBe(0);
  const drafts=JSON.parse(h.store.db.prepare('SELECT drafts FROM confirmations').get()!.drafts as string);
  expect(drafts[0][field]===null).toBe(true);expect(h.last().text).toContain('!edit');
});
it('allows unknown subject/title after explicit admin consent with a valid deadline, preserving nulls',async()=>{
  const h=fixture();await h.send('Assignment due 2027-05-20 18:00');
  expect(h.last().text).toContain('المادة: غير محددة');expect(h.last().text).toContain('اسم الواجب: غير محدد');expect(h.last().text).toContain('مكان التسليم: غير محدد');
  await h.send('نعم',group.admins[0],h.last().id);
  const saved=JSON.parse(h.store.db.prepare('SELECT data FROM assignments').get()!.data as string);
  expect(saved.course).toBeNull();expect(saved.name).toBeNull();expect(saved.destination).toBeNull();
  expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM reminder_jobs WHERE offset_hours=0').get()!.n).toBe(0);
});
it('supports numbered corrections, correct quotes and stale-preview protection before atomic registration',async()=>{
  const h=fixture();await h.send('يا شباب عندنا واجب التسليم بكرة');
  const first=h.last();await h.send('نعم',group.admins[0],first.id);
  expect(h.count('assignments')).toBe(0);expect(h.count('reminder_jobs')).toBe(0);
  await h.send('!edit 1 deadline=2027-05-20 18:00','249900000099@s.whatsapp.net',first.id);
  expect(h.count('confirmations')).toBe(1);
  await h.send('!edit 1 course=Networks',group.admins[0],first.id);const second=h.last();
  expect(second.replyTo).toBe(first.replyTo);expect(h.store.confirmation(group.id,first.id)).toBeUndefined();
  await h.send('!edit 1 name=Worksheet',group.admins[0],second.id);const third=h.last();
  await h.send('!edit 1 deadline=2027-05-20 18:00',group.admins[0],third.id);const corrected=h.last();
  await h.send('نعم',group.admins[0],first.id);expect(h.count('assignments')).toBe(0);
  await h.send('نعم',group.admins[0],corrected.id,group.id,'249900000099@s.whatsapp.net');expect(h.count('assignments')).toBe(0);
  await Promise.all([h.send('نعم',group.admins[0],corrected.id),h.send('نعم',group.admins[1],corrected.id)]);
  expect(h.count('assignments')).toBe(1);expect(h.count('reminder_jobs')).toBe(1);
  const data=JSON.parse(h.store.db.prepare('SELECT data FROM assignments').get()!.data as string);
  expect(data).toMatchObject({course:'Networks',name:'Worksheet',deadline:'2027-05-20T16:00:00.000Z',destination:null});
  expect(h.mock.sent.filter(message=>message.text.includes('تم تسجيل التكليفات بنجاح')).length).toBe(1);
});
it('preserves three distinct subjects, deadlines and Moodle/email/custom destinations',async()=>{
  const h=fixture();const original=h.raw(sudaneseAnnouncement);
  await h.control.receive({type:'notify',messages:[original]});expect(h.last().text).toContain('3. ');
  await h.send('نعم',group.admins[0],h.last().id);
  const rows=h.store.db.prepare('SELECT data FROM assignments ORDER BY position').all();
  expect(rows.map(row=>JSON.parse(row.data as string))).toEqual(expectedAssignments);
  await h.control.receive({type:'notify',messages:[original]});expect(h.count('assignments')).toBe(3);
});
it('rejects unauthorized/quoted announcements before draft creation and keeps diagnostics private',async()=>{
  const h=fixture();const privateBody='PRIVATE_DIAGNOSTIC_SENTINEL';
  await h.send(valid,'249900000099@s.whatsapp.net');await h.send(valid,group.leader,undefined,'120363000000000099@g.us');
  await h.send(valid,group.leader,undefined,'249900000099@s.whatsapp.net');await h.send(valid,group.leader,'unrelated-quote');
  await h.send(privateBody,'249900000099@s.whatsapp.net');expect(h.count('confirmations')).toBe(0);
  const serialized=JSON.stringify(h.diagnostics);
  for(const forbidden of [privateBody,group.id,group.leader,'@lid','249900000099'])expect(serialized.includes(forbidden)).toBe(false);
  expect(h.diagnostics.some(event=>event.code==='group_rejected')).toBe(true);expect(h.diagnostics.some(event=>event.code==='quoted_announcement_rejected')).toBe(true);
});
it('recovers a correction draft after a simulated process crash and rejects stale quoted approvals',async()=>{
  const h=fixture();await h.send('Assignment');const old=h.last();h.crash();
  const recovered=fixture({resume:true},h);
  await recovered.send('!edit 1 deadline=2027-05-20 18:00',group.admins[0],old.id);const replacement=recovered.last();
  expect(replacement.replyTo).toBe(old.replyTo);await recovered.send('نعم',group.admins[0],old.id);expect(recovered.count('assignments')).toBe(0);
  await recovered.send('نعم',group.admins[0],replacement.id);expect(recovered.count('assignments')).toBe(1);
});
it('requires explicit pilot override; normal production offsets remain 72/24/2 hours',async()=>{
  const h=fixture();h.store.configureReminders(group.id,{offsetHours:[72,24,2],mentions:'none'});
  await h.send(valid);await h.send('نعم',group.admins[0],h.last().id);
  expect(h.control.state.overrideEnabled).toBe(false);expect(h.control.state.reminderJobId).toBeUndefined();
  expect(h.store.db.prepare('SELECT offset_hours FROM reminder_jobs ORDER BY offset_hours').all().map(row=>row.offset_hours)).toEqual([2,24,72]);
  const drafts=extractAssignments(valid.replace('SUST Moodle','teacher@example.test'));
  expect(acceptsPilotDrafts(drafts)).toBe(true);expect(acceptsPilotDrafts([...drafts,...drafts])).toBe(true);
  expect(acceptsPilotDrafts([...drafts,...drafts],{maxAssignments:1})).toBe(false);
  expect(acceptsPilotDrafts(drafts,{allowedMethods:['SUST Moodle']})).toBe(false);
});
it('persists one exactly-five-minute override across restart, sends only the authorized job and preserves the actual deadline',async()=>{
  const options:ControlledOptions={reminder:{scope:'offline-test',delayMs:300000}};
  const h=fixture(options);await h.send(valid);h.advance(30000);const approvalTime=h.clock.value;
  await h.send('نعم',group.admins[0],h.last().id);
  const due=new Date(Date.parse(approvalTime)+300000).toISOString();expect(h.control.state.reminderDueAt).toBe(due);
  const id=h.control.state.reminderJobId!;const actualDeadline=h.store.db.prepare('SELECT deadline FROM assignments').get()!.deadline;
  h.advance(120000);h.crash();const recovered=fixture({...options,resume:true},h);
  expect(recovered.control.state.reminderJobId).toBe(id);
  recovered.advance(179999);await recovered.control.tick();expect(recovered.mock.sent.filter(message=>message.text.startsWith('تذكير بالتكليف')).length).toBe(0);
  recovered.advance(1);
  const forbidden=new ReminderWorker(recovered.store,recovered.mock,()=>false,()=>recovered.clock.value,60000,()=>{});
  await forbidden.tick(id);await forbidden.stop();expect(recovered.store.db.prepare('SELECT status FROM reminder_jobs WHERE id=?').get(id)!.status).toBe('pending');
  await recovered.control.tick();await recovered.control.tick();
  const reminders=recovered.mock.sent.filter(message=>message.text.startsWith('تذكير بالتكليف'));
  expect(reminders.length).toBe(1);for(const value of ['Networks','Worksheet','2027-05-20','18:00','SUST Moodle'])expect(reminders[0]!.text.includes(value)).toBe(true);
  expect(reminders[0]!.groupId).toBe(group.id);expect(reminders[0]!.options?.mentions).toBeUndefined();expect(reminders[0]!.options?.mentionAll).toBeUndefined();
  expect(recovered.store.db.prepare('SELECT deadline FROM assignments').get()!.deadline).toBe(actualDeadline);
  expect(recovered.store.db.prepare('SELECT status,attempts FROM reminder_jobs WHERE id=?').get(id)).toMatchObject({status:'sent',attempts:1});
  await recovered.control.stop();controls.delete(recovered.control);expect(recovered.control.state.overrideEnabled).toBe(false);
  expect(recovered.store.db.prepare('SELECT status FROM reminder_jobs WHERE offset_hours=24').get()!.status).toBe('pending');
});
it('does not retry an uncertain test reminder after restart or repeated scheduler ticks',async()=>{
  const options:ControlledOptions={reminder:{scope:'offline-test',delayMs:300000}};
  const h=fixture(options);await h.send(valid);await h.send('نعم',group.admins[0],h.last().id);h.fail();h.advance(300000);
  const before=h.attempts();await h.control.tick();await h.control.tick();expect(h.attempts()-before).toBe(1);
  expect(h.store.db.prepare('SELECT status FROM reminder_jobs WHERE id=?').get(h.control.state.reminderJobId!)!.status).toBe('failed');
  h.crash();expect(()=>fixture({...options,resume:true},h)).toThrow('Prior run requires review');
});
it('rolls back test schedule and controller state together if scheduling fails',async()=>{
  const h=fixture({reminder:{scope:'offline-test',delayMs:300000}});await h.send(valid);
  h.store.db.exec("CREATE TRIGGER refuse_test_schedule BEFORE INSERT ON reminder_jobs WHEN NEW.offset_hours=0 BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  await h.send('نعم',group.admins[0],h.last().id);
  expect(h.count('assignments')).toBe(1);
  expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM reminder_jobs WHERE offset_hours=0').get()!.n).toBe(0);
  const state=JSON.parse(h.store.db.prepare('SELECT state FROM pilot_test_run').get()!.state as string);
  expect(state.assignmentId).toBeUndefined();expect(state.reminderJobId).toBeUndefined();
  expect(state.status).toBe('failed_no_retry');
});
it('recovers registration committed before the test schedule was created',async()=>{
  const options:ControlledOptions={reminder:{scope:'offline-test',delayMs:300000}};
  const h=fixture(options);await h.send(valid);await h.send('نعم',group.admins[0],h.last().id);
  h.store.db.prepare('DELETE FROM reminder_jobs WHERE offset_hours=0').run();
  const state={...h.control.state};delete state.assignmentId;delete state.reminderJobId;delete state.reminderDueAt;
  h.store.db.prepare('UPDATE pilot_test_run SET state=?').run(JSON.stringify(state));h.crash();
  const recovered=fixture({...options,resume:true},h);await recovered.control.tick();
  expect(recovered.store.db.prepare('SELECT COUNT(*) AS n FROM reminder_jobs WHERE offset_hours=0').get()!.n).toBe(1);
  expect(recovered.control.state.reminderDueAt).toBe(new Date(Date.parse(h.clock.value)+300000).toISOString());
});
it('diagnostic sink failures cannot alter business operations',()=>{
  expect(()=>diagnostic(()=>{throw new Error('private exception');},'message_received')).not.toThrow();
});
