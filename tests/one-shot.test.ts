import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticationState, BinaryNode } from '@whiskeysockets/baileys';
import { createOneShotSocket, sendOneShot, type OneShotSocket } from '../src/pilot/one-shot.js';
import { verifiedProposal } from '../src/pilot/proposal.js';
import { checkPilot } from '../src/pilot/preflight.js';
import { Store } from '../src/database.js';
import { applyGroups } from '../src/whatsapp/config.js';
import { ReminderWorker } from '../src/reminders/worker.js';

const factory = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@whiskeysockets/baileys/lib/Socket/messages-send.js', () => ({ makeMessagesSocket: factory.create }));
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); factory.create.mockReset(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const target = '120363000000000000@g.us'; const own = '249900000003@s.whatsapp.net';
const group = { id: target, leader: '249900000001@s.whatsapp.net', admins: ['249900000002@s.whatsapp.net'], timezone: 'Africa/Khartoum', reminders: { offsetHours: [24], mentions: 'none' } };
const proposal = { expectedAccount: own, groupVerified: true, spareAccountMember: true, proposedGroups: [group], identities: { leader: { id: group.leader }, admins: [{ id: group.admins[0]! }] } };
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'one-shot-')); dirs.push(dir); return { dir, marker: join(dir, 'intent.json') }; }
function fake(behavior = 'accepted') {
  const ev = new EventEmitter(); const ws = new EventEmitter(); const end = vi.fn();
  const send = vi.fn(async (jid: string, _content: { text: string }, options: { messageId: string }) => {
    if (behavior === 'throw') throw new Error('mock failure');
    if (behavior !== 'no-ack') ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', from: jid, id: options.messageId, ...(behavior === 'rejected' ? { error: '403' } : {}) } });
    return { key: { remoteJid: jid, fromMe: true, id: options.messageId } };
  });
  const socket = { ev, ws, end, user: { id: own }, sendMessage: send } as unknown as OneShotSocket;
  const create = vi.fn(() => socket);
  return { socket, ev, ws, end, send, create };
}
async function connect(f: ReturnType<typeof fake>) { await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce()); f.ev.emit('connection.update', { connection: 'open' }); }
it('sends exact text once to the target, waits for server ack, closes, and prevents another run', async () => {
  const f = fake(); const { marker } = await fixture(); const start = vi.spyOn(ReminderWorker.prototype, 'start');
  const task = sendOneShot(target, own, marker, { createSocket: f.create, saveCreds: async () => {} });
  await connect(f); await task;
  expect(f.send).toHaveBeenCalledOnce(); expect(f.send.mock.calls[0]![0]).toBe(target);
  expect(f.send.mock.calls[0]![1]).toEqual({ text: 'online now' });
  expect(Object.keys(f.send.mock.calls[0]![2])).toEqual(['messageId']);
  expect(f.ev.listenerCount('messages.upsert')).toBe(0); expect(start).not.toHaveBeenCalled(); expect(f.end).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe('accepted');
  await expect(sendOneShot(target, own, marker, { createSocket: f.create, saveCreds: async () => {} })).rejects.toThrow();
  expect(f.send).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce();
});
it.each(['throw', 'rejected'])('does not retry after %s', async behavior => {
  const f = fake(behavior); const { marker } = await fixture();
  const task = sendOneShot(target, own, marker, { createSocket: f.create, saveCreds: async () => {} }); const failed = expect(task).rejects.toThrow();
  await connect(f); await failed; expect(f.send).toHaveBeenCalledOnce(); expect(f.end).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe(behavior === 'throw' ? 'uncertain' : 'rejected');
});
it('does not treat a resolved send or unrelated ack as server acceptance and never retries', async () => {
  vi.useFakeTimers(); const f = fake('no-ack'); const { marker } = await fixture();
  const task = sendOneShot(target, own, marker, { createSocket: f.create, saveCreds: async () => {} }); const failed = expect(task).rejects.toThrow();
  await connect(f); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  f.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: 'unrelated' } });
  f.ws.emit('CB:ack,class:message', { tag: 'ack', attrs: { class: 'message', id: f.send.mock.calls[0]![2].messageId, from: 'other@g.us' } });
  await vi.advanceTimersByTimeAsync(90_000); await failed;
  expect(f.send).toHaveBeenCalledOnce(); expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe('uncertain');
});
it.each(['wrong-account', 'qr', 'disconnect'])('fails before sending on %s', async scenario => {
  const f = fake(); const { marker } = await fixture();
  const task = sendOneShot(target, scenario === 'wrong-account' ? '249900000009@s.whatsapp.net' : own, marker, { createSocket: f.create, saveCreds: async () => {} });
  const failed = expect(task).rejects.toThrow(); await vi.waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  f.ev.emit('connection.update', scenario === 'qr' ? { qr: 'mock-only' } : { connection: scenario === 'disconnect' ? 'close' : 'open' });
  await failed; expect(f.send).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(marker, 'utf8')).status).toBe('failed');
});
it('rejects private-chat targets before creating a socket', async () => {
  const f = fake(); const { marker } = await fixture();
  await expect(sendOneShot(own, own, marker, { createSocket: f.create, saveCreds: async () => {} })).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
});
it('limits the SDK send layer to one exact application send and removes automatic hooks', async () => {
  const f = fake(); const ev = Object.assign(f.ev, { removeAllListeners: f.ev.removeAllListeners.bind(f.ev) });
  factory.create.mockReturnValue({ ...f.socket, ev, ws: f.ws });
  const socket = createOneShotSocket({ creds: {} } as AuthenticationState, target);
  const config = factory.create.mock.calls[0]![0];
  expect(config.fireInitQueries).toBe(false); expect(config.enableRecentMessageCache).toBe(false); expect(config.maxMsgRetryCount).toBe(0);
  expect(config.emitOwnEvents).toBe(false); expect(config.shouldIgnoreJid(target)).toBe(true);
  await expect(socket.sendMessage(own, { text: 'online now' }, { messageId: 'mock-id' })).rejects.toThrow();
  await expect(socket.sendMessage(target, { text: 'different' }, { messageId: 'mock-id' })).rejects.toThrow();
  await socket.sendMessage(target, { text: 'online now' }, { messageId: 'mock-id' });
  await expect(socket.sendMessage(target, { text: 'online now' }, { messageId: 'mock-id' })).rejects.toThrow();
  expect(f.send).toHaveBeenCalledOnce();
});
it('validates verified proposal roles and keeps exact default settings', () => {
  expect(verifiedProposal(proposal).groups).toEqual([group]);
  for (const changed of [{ groupVerified: false }, { expectedAccount: '' }, { proposedGroups: [group, group] },
    { identities: { leader: { id: own }, admins: [{ id: group.admins[0] }] } },
    { proposedGroups: [{ ...group, reminders: { offsetHours: [24], mentions: 'native_all' } }] }]) expect(() => verifiedProposal({ ...proposal, ...changed })).toThrow();
});
it('validates isolated configured DB roles and rejects queues or a development database', async () => {
  const { dir } = await fixture(); const pilot = join(dir, 'data/pilot'); await mkdir(pilot, { recursive: true });
  const db = join(pilot, 'pilot.sqlite'); let store = new Store(db); applyGroups(store, [group]); store.close();
  await writeFile(join(pilot, 'groups.json'), JSON.stringify([group])); await writeFile(join(pilot, 'metadata-result.json'), JSON.stringify(proposal));
  const env = { WHATSAPP_ENABLE_LIVE: 'false', GROUPS_CONFIG_PATH: 'data/pilot/groups.json', DATABASE_PATH: 'data/pilot/pilot.sqlite' };
  expect(await checkPilot(dir, env)).toMatchObject({ authorizedGroups: 1, outgoingMessages: 0, mentions: 'none' });
  await expect(checkPilot(dir, { ...env, DATABASE_PATH: 'data/bot.sqlite' })).rejects.toThrow();
  await expect(checkPilot(dir, { ...env, WHATSAPP_ENABLE_LIVE: 'true' })).rejects.toThrow();
  store = new Store(db); store.db.prepare('UPDATE groups SET leader=?').run(own); store.close();
  await expect(checkPilot(dir, env)).rejects.toThrow('permissions');
});
