import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticationState, BinaryNode, WAMessage } from '@whiskeysockets/baileys';
import { Store } from '../src/database.js';
import { applyGroups } from '../src/whatsapp/config.js';
import { ControlledTest, type ControlledOptions } from '../src/pilot/controlled.js';
import { controlledSocket } from '../src/pilot/controlled-socket.js';
import type { Socket } from '../src/whatsapp/adapter.js';

const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@whiskeysockets/baileys', async original => ({ ...await original<typeof import('@whiskeysockets/baileys')>(), default: factory.create }));
const stores: Store[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); factory.create.mockReset(); stores.splice(0).forEach(store => store.close()); });
const group = { id: '120363000000000001@g.us', leader: '249900000001@s.whatsapp.net', admins: ['249900000002@s.whatsapp.net'], timezone: 'Africa/Khartoum', reminders: { offsetHours: [24], mentions: 'none' as const } };
const self = '249900000003@s.whatsapp.net';
const announcement = 'المادة: شبكات\nاسم التكليف: واجب تجريبي\nالموعد النهائي: 2026-10-20 18:00\nالتسليم: SUST Moodle';
function harness(options: ControlledOptions = { reminder: { scope: 'offline-test', delayMs: 300000 } }) {
  const store = new Store(); stores.push(store); applyGroups(store, [group]);
  let now = '2026-10-15T18:00:00.000Z'; const notify = vi.fn(); const finish = vi.fn();
  const sent: { text: string; options: Record<string, unknown>; content: Record<string, unknown> }[] = [];
  let fail = false;
  const socket = { ev: new EventEmitter(), user: { id: self }, end: vi.fn(), sendMessage: vi.fn(async (jid: string, content: Record<string, unknown>, options: Record<string, unknown>) => {
    sent.push({ text: content.text as string, content, options });
    if (fail) throw new Error('Simulated uncertain ACK');
    return { key: { remoteJid: jid, fromMe: true, id: options.messageId as string } };
  }) };
  const aliases = new Map([[group.leader, group.leader], ['100000000001@lid', group.leader], [group.admins[0]!, group.admins[0]!], ['100000000002@lid', group.admins[0]!]]);
  const controller = new ControlledTest(store, group, aliases, notify, finish, () => now, options);
  controller.start(socket as unknown as Socket);
  let serial = 0;
  const raw = (text: string, sender = group.leader, quote?: string, chat = group.id, author = self): WAMessage => ({ key: { remoteJid: chat, fromMe: false, participant: sender, id: `in-${++serial}` }, message: quote ? { extendedTextMessage: { text, contextInfo: { stanzaId: quote, participant: author, remoteJid: chat } } } : { conversation: text } });
  const receive = (message: WAMessage) => controller.receive({ type: 'notify', messages: [message] });
  return { store, controller, sent, notify, finish, raw, receive, advance: (ms: number) => { now = new Date(Date.parse(now) + ms).toISOString(); }, fail: () => { fail = true; } };
}
it('runs one real bot workflow: leader LID detection, exact admin quote, one registration/list and one five-minute reminder', async () => {
  const h = harness(); const original = h.raw(announcement, '100000000001@lid');
  await h.receive(h.raw(announcement, '249900000099@s.whatsapp.net'));
  await h.receive(h.raw(announcement, group.leader, undefined, '120363000000000099@g.us'));
  await h.receive(original);
  expect(h.sent).toHaveLength(1); expect(h.sent[0]!.text).toContain('هل تريد تسجيل التكليفات');
  const previewId = h.sent[0]!.options.messageId as string;
  await h.receive(h.raw('نعم', group.admins[0], previewId, group.id, '249900000099@s.whatsapp.net'));
  expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(0);
  const jobCountsWhenDisplayed: number[] = [];
  h.notify.mockImplementation((event: string) => { if (event.startsWith('Expected pilot reminder')) jobCountsWhenDisplayed.push(Number(h.store.db.prepare('SELECT COUNT(*) AS n FROM reminder_jobs WHERE offset_hours=0').get()!.n)); });
  await h.receive(h.raw('نعم', '100000000002@lid', previewId));
  expect(h.sent).toHaveLength(2); expect(h.sent[1]!.text).toBe('تم تسجيل التكليفات بنجاح.');
  expect(jobCountsWhenDisplayed).toEqual([0]);
  expect(h.controller.state.reminderDueAt).toBe('2026-10-15T18:05:00.000Z');
  await h.receive(original); await h.receive(h.raw(announcement)); await h.receive(h.raw('نعم', group.admins[0], previewId));
  expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(1);
  await h.receive(h.raw('!list')); await h.receive(h.raw('!list'));
  expect(h.sent).toHaveLength(3); expect(h.sent[2]!.text).toContain('شبكات');
  h.advance(299000); await h.controller.tick(); expect(h.sent).toHaveLength(3);
  h.advance(1000); await h.controller.tick(); await h.controller.tick();
  expect(h.sent).toHaveLength(4);
  for (const value of ['شبكات', 'واجب تجريبي', '2026-10-20', '18:00', 'SUST Moodle']) expect(h.sent[3]!.text).toContain(value);
  for (const send of h.sent) { expect(send.content.mentions).toBeUndefined(); expect(send.content.mentionAll).toBeUndefined(); }
  expect(h.controller.state.status).toBe('completed');
  expect(h.store.db.prepare("SELECT status FROM reminder_jobs WHERE offset_hours=0").get()!.status).toBe('sent');
  expect(h.store.db.prepare("SELECT status FROM reminder_jobs WHERE offset_hours=24").get()!.status).toBe('pending');
  await h.controller.stop(); expect(h.controller.state.overrideEnabled).toBe(false);
});
it('fails permanently without retry after an uncertain preview send', async () => {
  const h = harness(); h.fail(); await h.receive(h.raw(announcement));
  await h.controller.tick(); await h.controller.tick();
  expect(h.sent).toHaveLength(1); expect(h.finish).toHaveBeenCalled();
  expect(h.store.db.prepare('SELECT status FROM outgoing_messages').get()!.status).toBe('failed');
  expect(h.store.db.prepare('SELECT status FROM pilot_test_sends').get()!.status).toBe('uncertain');
  await h.controller.stop();
});
it('admits multiple and late assignments as drafts while blocking unrelated commands', async () => {
  const h = harness();
  for (const text of ['!help', '!edit 1 name=other', '!list']) await h.receive(h.raw(text));
  expect(h.sent).toHaveLength(0); expect(h.controller.state.announcementId).toBeUndefined();
  await h.receive(h.raw(announcement+'\n\n'+announcement));
  expect(h.sent).toHaveLength(1);
  expect(JSON.parse(h.store.db.prepare('SELECT drafts FROM confirmations').get()!.drafts as string)).toHaveLength(2);
  await h.controller.stop();
  const late = harness();
  await late.receive(late.raw(announcement.replace('2026-10-20 18:00','2026-10-15 22:00')));
  expect(late.sent).toHaveLength(1); expect(late.store.db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n).toBe(0);
  await late.controller.stop();
});
it('cannot restart a prior controlled run or create a second draft after a preview', async () => {
  const h = harness();
  expect(() => new ControlledTest(h.store, group, new Map(), () => {}, () => {})).toThrow();
  await h.receive(h.raw(announcement)); await h.receive(h.raw(announcement));
  expect(h.sent).toHaveLength(1); expect(h.store.db.prepare('SELECT COUNT(*) AS n FROM announcements').get()!.n).toBe(1);
  await h.controller.stop();
});
it('gates raw incoming envelopes before SDK handlers and disables SDK retries, history and enumeration hooks', async () => {
  const ev = new EventEmitter(); const ws = new EventEmitter(); const receive = vi.fn(); ws.on('CB:message', receive);
  for (const event of ['CB:receipt','CB:ib,,dirty','CB:notification']) ws.on(event, vi.fn());
  const send = vi.fn(async (jid: string, _content: unknown, options: {messageId: string}) => {
    ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: options.messageId, from: jid } });
    return { key: { id: options.messageId, remoteJid: jid, fromMe: true } };
  });
  factory.create.mockReturnValue({ ev, ws, user: {id:self}, sendMessage:send });
  const socket = controlledSocket({creds:{}} as AuthenticationState,group.id);
  for (const from of [self,'120363000000000099@g.us']) ws.emit('CB:message',{attrs:{from},get content(){throw new Error('Unrelated body read');}});
  ws.emit('CB:message',{attrs:{from:group.id,offline:'1'}});
  expect(receive).not.toHaveBeenCalled(); ws.emit('CB:message',{attrs:{from:group.id}}); expect(receive).toHaveBeenCalledOnce();
  expect(ws.listenerCount('CB:receipt')).toBe(0); expect(ws.listenerCount('CB:ib,,dirty')).toBe(0);
  const config = factory.create.mock.calls[0]![0]; expect(config.maxMsgRetryCount).toBe(0); expect(config.fireInitQueries).toBe(false);
  await socket.sendMessage(group.id,{text:'approved preview'},{messageId:'MOCK'});
  expect(send).toHaveBeenCalledOnce();
  await expect(socket.sendMessage(self,{text:'blocked'},{messageId:'OTHER'})).rejects.toThrow();
});
it('treats a missing server acknowledgment as uncertain even if sendMessage resolves', async () => {
  vi.useFakeTimers(); const ev=new EventEmitter(), ws=new EventEmitter();
  const send=vi.fn(async()=>({key:{remoteJid:group.id,fromMe:true,id:'MOCK'}}));
  factory.create.mockReturnValue({ev,ws,user:{id:self},sendMessage:send});
  const socket=controlledSocket({creds:{}} as AuthenticationState,group.id);
  const task=socket.sendMessage(group.id,{text:'approved preview'},{messageId:'MOCK'}); const rejected=expect(task).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30000); await rejected; expect(send).toHaveBeenCalledOnce();
});
