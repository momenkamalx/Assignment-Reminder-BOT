import { EventEmitter } from 'node:events';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason, initAuthCreds, generateWAMessageContent, type MessageContentGenerationOptions, type WAMessage, type BaileysEventMap, type AuthenticationState } from '@whiskeysockets/baileys';
import { Store } from '../src/database.js';
import { BaileysAdapter, type Socket } from '../src/whatsapp/adapter.js';
import { applyGroups, parseGroups } from '../src/whatsapp/config.js';
import { liveDependencies, WhatsAppRuntime } from '../src/whatsapp/runtime.js';
import { externalAuthPath } from '../src/whatsapp/auth-path.js';
import { migrations } from '../src/migrations.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import { DatabaseSync } from 'node:sqlite';
import { sudaneseAnnouncement } from './fixtures/sudanese-announcement.js';

const group = '120363000000000000@g.us';
const leader = '249900000001@s.whatsapp.net';
const admin = '249900000002@s.whatsapp.net';
const student = '249900000003@s.whatsapp.net';
const self = '249900000004@s.whatsapp.net';
const configs = () => parseGroups([{ id: group, leader, admins: [admin] }]);
const incoming = (text: string, sender = leader, chat = group, quote?: string): WAMessage => ({
  key: { remoteJid: chat, id: crypto.randomUUID(), participant: sender, fromMe: false },
  message: quote ? { extendedTextMessage: { text, contextInfo: { stanzaId: quote, participant: self } } } : { conversation: text },
});
class FakeSocket {
  ev = new EventEmitter();
  user = { id: self, lid: '555@lid' };
  end = vi.fn();
  sendMessage = vi.fn(async (_group: string, _content: unknown, _options: unknown): Promise<WAMessage> => ({ key: { remoteJid: _group, id: (_options as { messageId?: string })?.messageId ?? crypto.randomUUID(), fromMe: true } }));
  asSocket() { return this as unknown as Socket; }
}
let store: Store, adapter: BaileysAdapter, socket: FakeSocket;
beforeEach(() => {
  store = new Store(); applyGroups(store, configs());
  adapter = new BaileysAdapter(store, configs(), () => '2027-01-01T00:00:00.000Z');
  socket = new FakeSocket(); adapter.attach(socket.asSocket(), true);
});
afterEach(() => { store.close(); vi.useRealTimers(); });
const receive = (messages: WAMessage[], type: 'notify' | 'append' = 'notify') => adapter.receive({ messages, type });

describe('Baileys transport boundary', () => {
  it('passes native and individual mention metadata and stable message IDs through the transport', async () => {
    await adapter.send(group, 'hello', undefined, { messageId: 'PERSISTENT', mentionAll: true });
    expect(socket.sendMessage.mock.calls[0]).toEqual([group, { text: 'hello', mentions: undefined, mentionAll: true }, { messageId: 'PERSISTENT' }]);
    await adapter.send(group, 'hello @249111', undefined, { mentions: ['249111@s.whatsapp.net'] });
    expect(socket.sendMessage.mock.calls[1]![1]).toMatchObject({ mentions: ['249111@s.whatsapp.net'], mentionAll: undefined });
  });
  it('uses native mentionAll metadata; plain @all has no broadcast mention metadata', async () => {
    const native = await generateWAMessageContent({ text: 'hello', mentionAll: true }, {} as MessageContentGenerationOptions);
    const plain = await generateWAMessageContent({ text: '@all' }, {} as MessageContentGenerationOptions);
    const individual = await generateWAMessageContent({ text: '@249111', mentions: ['249111@s.whatsapp.net'] }, {} as MessageContentGenerationOptions);
    expect(native.extendedTextMessage!.contextInfo!.nonJidMentions).toBe(1);
    expect(plain.extendedTextMessage?.contextInfo?.nonJidMentions ?? 0).toBe(0);
    expect(individual.extendedTextMessage!.contextInfo!.mentionedJid).toEqual(['249111@s.whatsapp.net']);
  });
  it('looks up participant JIDs only for the requested authorized group', async () => {
    const metadata = vi.fn(async (id: string) => ({ id, participants: [{ id: '249111:7@s.whatsapp.net' }, { id: '666@lid' }] }));
    adapter.attach({ ...socket.asSocket(), groupMetadata: metadata } as unknown as Socket, true);
    expect(await adapter.members(group)).toEqual(['249111@s.whatsapp.net', '666@lid']);
    await expect(adapter.members('120363999999999999@g.us')).rejects.toThrow('unavailable');
    expect(metadata).toHaveBeenCalledTimes(1);
  });
  it('feeds a three-assignment announcement and exact quoted admin approval into the existing bot', async () => {
    const original = incoming(sudaneseAnnouncement);
    await receive([original]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const [chat, content, options] = socket.sendMessage.mock.calls[0]!;
    expect(chat).toBe(group);
    expect((content as { text: string }).text).toContain('3. الرياضيات');
    expect((options as { quoted: WAMessage }).quoted.key.id).toBe(original.key.id);
    const previewId = (await socket.sendMessage.mock.results[0]!.value).key.id!;
    await receive([incoming('نعم', student, group, previewId)]);
    await receive([incoming('yes', leader, group, previewId)]);
    expect(store.upcoming(group, '2027-01-01')).toHaveLength(0);
    await receive([incoming('نعم', admin, group, previewId)]);
    expect(store.upcoming(group, '2027-01-01')).toHaveLength(3);
    await receive([original, incoming('yes', admin, group, previewId)]);
    expect(store.upcoming(group, '2027-01-01')).toHaveLength(3);
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('rejects unauthorized groups, private chats, statuses and broadcasts before reading their content', async () => {
    for (const chat of ['120363999999999999@g.us', leader, 'status@broadcast', '123@newsletter']) {
      const message = incoming(sudaneseAnnouncement, leader, chat);
      Object.defineProperty(message, 'message', { get: () => { throw new Error('Unauthorized body accessed'); } });
      await receive([message]);
      await expect(adapter.send(chat, 'test')).rejects.toThrow('allowlist');
    }
    expect(socket.sendMessage).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM whatsapp_keys').get()?.count).toBe(0);
  });
  it('ignores self messages, ordinary students, history, media and incomplete keys', async () => {
    const own = incoming(sudaneseAnnouncement); own.key.fromMe = true;
    const noSender = incoming(sudaneseAnnouncement); noSender.key.participant = undefined;
    const noId = incoming(sudaneseAnnouncement); noId.key.id = undefined;
    const media = incoming(''); media.message = { imageMessage: { caption: sudaneseAnnouncement } };
    await receive([own, noSender, noId, media, incoming(sudaneseAnnouncement, student)]);
    await receive([incoming(sudaneseAnnouncement)], 'append');
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
  it('supports wrapped text and trusted LID/phone alternate identity, not display names', async () => {
    const message = incoming('عندنا تمرين تسليم 2027-05-20 18:00', '111@lid');
    message.key.participantAlt = '249900000001:7@s.whatsapp.net';
    message.message = { ephemeralMessage: { message: message.message } };
    await receive([message]);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const stranger = incoming(sudaneseAnnouncement, student); stranger.pushName = 'Student Leader';
    await receive([stranger]); expect(socket.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('rejects conflicting configured participant identities', async () => {
    const message = incoming(sudaneseAnnouncement); message.key.participantAlt = admin;
    await receive([message]); expect(socket.sendMessage).not.toHaveBeenCalled();
  });
  it('refuses a confirmation quote naming another author or another chat', async () => {
    await receive([incoming(sudaneseAnnouncement)]);
    const id = (await socket.sendMessage.mock.results[0]!.value).key.id!;
    const forged = incoming('yes', admin, group, id);
    forged.message!.extendedTextMessage!.contextInfo!.participant = leader;
    const crossGroup = incoming('yes', admin, group, id);
    crossGroup.message!.extendedTextMessage!.contextInfo!.remoteJid = '120363999999999999@g.us';
    const noAuthor = incoming('yes', admin, group, id);
    noAuthor.message!.extendedTextMessage!.contextInfo!.participant = undefined;
    await receive([forged, crossGroup, noAuthor]);
    expect(store.upcoming(group, '2027-01-01')).toHaveLength(0);
  });
  it('retains only original message keys for quoting an edited draft after adapter restart', async () => {
    const original = incoming('المادة: الرياضيات\nعندنا تمرين');
    await receive([original]);
    const previewId = (await socket.sendMessage.mock.results[0]!.value).key.id!;
    adapter = new BaileysAdapter(store, configs(), () => '2027-01-01T00:00:00.000Z');
    adapter.attach(socket.asSocket(), true);
    await receive([incoming('!edit 1 deadline=2027-05-20 18:00', admin, group, previewId)]);
    const options = socket.sendMessage.mock.calls[1]![2] as { quoted: WAMessage };
    expect(options.quoted.key.id).toBe(original.key.id);
    const keyRow = store.db.prepare('SELECT key_json FROM whatsapp_keys').get()!;
    expect(keyRow.key_json).not.toContain('عندنا');
    const editedId = (await socket.sendMessage.mock.results[1]!.value).key.id!;
    await receive([incoming('yes', admin, group, editedId)]);
    expect(store.upcoming(group, '2027-01-01')).toHaveLength(1);
  });
  it('blocks sends while disconnected and ignores unknown quoted messages', async () => {
    adapter.attach(socket.asSocket(), false);
    await expect(adapter.send(group, 'test')).rejects.toThrow('disconnected');
    await receive([incoming(sudaneseAnnouncement)]);
    adapter.attach(socket.asSocket(), true);
    await expect(adapter.send(group, 'test', 'unknown')).rejects.toThrow('unavailable');
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
  it('uses the current config allowlist even if removed groups remain in historical SQLite records', async () => {
    const other = '120363999999999999@g.us'; store.configureGroup(other, leader, [admin]);
    await receive([incoming(sudaneseAnnouncement, leader, other)]);
    expect(socket.sendMessage).not.toHaveBeenCalled();
  });
});

describe('group configuration', () => {
  it('accepts per-group reminder options and rejects unsupported mention modes or offsets', () => {
    const base = { id: group, leader, admins: [admin] };
    const reminders = { offsetHours: [72, 24, 2], mentions: 'individual' };
    expect(parseGroups([{ ...base, reminders }])[0]!.reminders).toEqual(reminders);
    expect(() => parseGroups([{ ...base, reminders: { offsetHours: [24], mentions: 'plain_at_all' } }])).toThrow();
    expect(() => parseGroups([{ ...base, reminders: { offsetHours: [2], mentions: 'none' } }])).toThrow();
  });
  it('normalizes device JIDs and defaults to Africa/Khartoum', () => {
    expect(parseGroups([{ id: group, leader: '249900000001:7@s.whatsapp.net', admins: [admin, admin] }])).toEqual(configs());
  });
  it.each([[], [{ id: leader, leader, admins: [admin] }], [{ id: group, leader: 'Bob', admins: [admin] }], [{ id: group, leader, admins: [] }], [{ id: group, leader, admins: [admin], timezone: 'invalid' }], [{ id: group, leader, admins: [admin] }, { id: group, leader, admins: [admin] }]])('rejects malformed configuration %#', value => {
    expect(() => parseGroups(value)).toThrow();
  });
});

describe('connection lifecycle (fake sockets only)', () => {
  let runtime: WhatsAppRuntime;
  afterEach(async () => { runtime?.stop(); await runtime?.idle(); });
  function setup() {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const auth: AuthenticationState = { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } };
    const saveCreds = vi.fn(async () => {});
    const loadAuth = vi.fn(async () => ({ state: auth, saveCreds }));
    const createSocket = vi.fn(() => { const s = new FakeSocket(); sockets.push(s); return s.asSocket(); });
    const qr = vi.fn(), log = vi.fn();
    runtime = new WhatsAppRuntime(adapter, { loadAuth, createSocket, qr, log });
    return { sockets, saveCreds, loadAuth, createSocket, qr, log };
  }
  const close = (s: FakeSocket, code: number) => s.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
  it('loads persistent auth, emits QR, saves credential changes and routes messages only after open', async () => {
    const f = setup(); await runtime.start();
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', { qr: 'fake-qr-only' }); expect(f.qr).toHaveBeenCalledWith('fake-qr-only');
    s.ev.emit('creds.update', {}); await runtime.idle(); expect(f.saveCreds).toHaveBeenCalledTimes(1);
    s.ev.emit('messages.upsert', { messages: [incoming(sudaneseAnnouncement)], type: 'notify' });
    await runtime.idle(); expect(s.sendMessage).not.toHaveBeenCalled();
    s.ev.emit('connection.update', { connection: 'open' });
    s.ev.emit('messages.upsert', { messages: [incoming(sudaneseAnnouncement)], type: 'notify' });
    await runtime.idle(); expect(s.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.log.mock.calls.flat().join(' ')).not.toContain('fake-qr-only');
  });
  it('reconnects with backoff, reloads auth, detaches old listeners and cancels reconnect on stop', async () => {
    const f = setup(); await runtime.start();
    close(f.sockets[0]!, DisconnectReason.connectionClosed);
    expect(f.sockets[0]!.ev.listenerCount('messages.upsert')).toBe(0);
    await vi.advanceTimersByTimeAsync(999); expect(f.createSocket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.loadAuth).toHaveBeenCalledTimes(2);
    close(f.sockets[1]!, DisconnectReason.connectionClosed);
    await vi.advanceTimersByTimeAsync(1999); expect(f.createSocket).toHaveBeenCalledTimes(2);
    runtime.stop(); await vi.advanceTimersByTimeAsync(30000); expect(f.createSocket).toHaveBeenCalledTimes(2);
  });
  it('flushes changed credentials before restarting the socket after pairing', async () => {
    const f = setup(); await runtime.start();
    f.sockets[0]!.ev.emit('creds.update', {});
    close(f.sockets[0]!, DisconnectReason.restartRequired);
    await vi.advanceTimersByTimeAsync(0); await runtime.idle();
    expect(f.saveCreds).toHaveBeenCalledTimes(1);
    expect(f.loadAuth).toHaveBeenCalledTimes(2);
    expect(f.saveCreds.mock.invocationCallOrder[0]).toBeLessThan(f.loadAuth.mock.invocationCallOrder[1]!);
  });
  it.each([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden])('does not reconnect automatically for terminal reason %s', async code => {
    const f = setup(); await runtime.start(); close(f.sockets[0]!, code);
    await vi.advanceTimersByTimeAsync(60000); expect(f.createSocket).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith('whatsapp-session-requires-attention');
  });
  it('fails closed if auth saving fails and logs no secrets', async () => {
    const f = setup(); f.saveCreds.mockRejectedValue(new Error('SECRET token'));
    await runtime.start(); f.sockets[0]!.ev.emit('creds.update', {}); await runtime.idle();
    expect(f.sockets[0]!.end).toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join(' ')).not.toContain('SECRET');
  });
  it('persists a transport failure for worker recovery without losing the incoming draft', async () => {
    const f = setup(); await runtime.start(); const s = f.sockets[0]!;
    s.ev.emit('connection.update', { connection: 'open' });
    s.sendMessage.mockRejectedValueOnce(new Error('sensitive transport error'));
    const original = incoming(sudaneseAnnouncement);
    s.ev.emit('messages.upsert', { messages: [original], type: 'notify' }); await runtime.idle();
    expect(store.db.prepare('SELECT status,attempts FROM outgoing_messages').get()).toMatchObject({ status: 'pending', attempts: 1 });
    s.ev.emit('messages.upsert', { messages: [original], type: 'notify' }); await runtime.idle();
    const delivery = new ReminderWorker(store, adapter, () => true, () => '2027-01-01T00:00:01.000Z', 60000, () => {});
    await delivery.flushOutgoing();
    expect(s.sendMessage).toHaveBeenCalledTimes(2);
  });
  it('retries a transient socket-creation failure during reconnection', async () => {
    const f = setup(); await runtime.start();
    f.createSocket.mockImplementationOnce(() => { throw new Error('temporary failure'); });
    close(f.sockets[0]!, DisconnectReason.connectionClosed);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.log).toHaveBeenCalledWith('whatsapp-reconnect-failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.createSocket).toHaveBeenCalledTimes(3);
  });
});

describe('offline safety and authentication persistence', () => {
  it('rejects auth paths inside the project, including misleading dot-dot prefixes', async () => {
    await expect(externalAuthPath(process.cwd())).rejects.toThrow('outside');
    await expect(externalAuthPath(join(process.cwd(), 'auth'))).rejects.toThrow('outside');
    await expect(externalAuthPath(join(process.cwd(), '..auth'))).rejects.toThrow('outside');
    const folder = mkdtempSync(join(tmpdir(), 'wa-external-path-'));
    try { expect(await externalAuthPath(join(folder, 'auth'))).toContain('auth'); }
    finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('upgrades a Stage 1 database without changing its saved group configuration', () => {
    const folder = mkdtempSync(join(tmpdir(), 'wa-migration-test-'));
    let upgraded: Store | undefined;
    try {
      const path = join(folder, 'old.sqlite');
      const old = new DatabaseSync(path);
      old.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY); INSERT INTO migrations VALUES(1);');
      old.exec(migrations[0]!.sql);
      old.prepare('INSERT INTO groups VALUES(?,?,?,?)').run(group, leader, JSON.stringify([admin]), 'Africa/Khartoum');
      old.close();
      upgraded = new Store(path);
      expect(upgraded.group(group)?.leader).toBe(leader);
      expect(upgraded.db.prepare('SELECT version FROM migrations ORDER BY version').all()).toEqual(migrations.map(m => ({ version: m.version })));
      expect(upgraded.db.prepare('SELECT COUNT(*) AS count FROM whatsapp_keys').get()?.count).toBe(0);
    } finally { upgraded?.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it('persists and reloads real multi-file credentials and keys without creating any socket', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'wa-auth-test-'));
    try {
      const deps = liveDependencies(adapter, folder, vi.fn());
      const first = await deps.loadAuth();
      first.state.creds.registered = true;
      await first.saveCreds();
      await first.state.keys.set({ session: { 'fake-session': Buffer.from('offline-test-key') } });
      const second = await deps.loadAuth();
      expect(second.state.creds.registered).toBe(true);
      expect(second.state.creds.noiseKey.public).toEqual(first.state.creds.noiseKey.public);
      expect((await second.state.keys.get('session', ['fake-session']))['fake-session']).toEqual(Buffer.from('offline-test-key'));
      expect(socket.sendMessage).not.toHaveBeenCalled();
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });
  it('the real entry point stays offline and creates no auth/database files when disabled', () => {
    const folder = mkdtempSync(join(tmpdir(), 'wa-disabled-test-'));
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/whatsapp/main.ts'], {
        env: { ...process.env, WHATSAPP_ENABLE_LIVE: 'false', GROUPS_CONFIG_PATH: join(folder, 'missing.json'), WHATSAPP_AUTH_DIR: join(folder, 'auth'), DATABASE_PATH: join(folder, 'bot.sqlite') },
        encoding: 'utf8', timeout: 20000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Live WhatsApp is disabled');
      expect(existsSync(join(folder, 'auth'))).toBe(false);
      expect(existsSync(join(folder, 'bot.sqlite'))).toBe(false);
    } finally { rmSync(folder, { recursive: true, force: true }); }
  }, 25000);
});
