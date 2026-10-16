import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticationState, BinaryNode } from '@whiskeysockets/baileys';
import { identifyPrivateGroup, parseMetadataRequest } from '../src/pilot/metadata.js';
import { createMetadataSocket, runMetadataOnly, type MetadataSocket } from '../src/pilot/metadata-runtime.js';
import { ReminderWorker } from '../src/reminders/worker.js';

const base = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@whiskeysockets/baileys/lib/Socket/socket.js', () => ({ makeSocket: base.create }));
afterEach(() => { vi.restoreAllMocks(); base.create.mockReset(); vi.useRealTimers(); });
const gid = '120363000000000000@g.us';
const leader = '249900000001@s.whatsapp.net'; const admin = '249900000002@s.whatsapp.net';
const account = { id: '249900000003:7@s.whatsapp.net', lid: '100000000003@lid' };
const input = { expectedGroupName: 'Private pilot', groupJid: gid, leader, admins: [admin] };
function response(id = gid, name = 'Private pilot'): BinaryNode {
  return { tag: 'iq', attrs: {}, content: [{ tag: 'group', attrs: { id, subject: name }, content: [
    { tag: 'participant', attrs: { jid: '100000000001@lid', phone_number: leader } },
    { tag: 'participant', attrs: { jid: admin, lid: '100000000002@lid' } },
    { tag: 'participant', attrs: { jid: account.lid, phone_number: '249900000003@s.whatsapp.net' } },
    { tag: 'participant', attrs: { jid: '249900000099@s.whatsapp.net' } },
  ] }] };
}
it('queries only the supplied group and retains only selected phone/LID identities', async () => {
  const query = vi.fn(async () => response());
  const result = await identifyPrivateGroup(parseMetadataRequest(input), account, query);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[0]).toMatchObject({ attrs: { to: gid, type: 'get' } });
  expect(result.proposedGroups[0]).toMatchObject({ id: gid, leader, admins: [admin], reminders: { mentions: 'none', offsetHours: [24] } });
  expect(result.identities.leader).toMatchObject({ id: '100000000001@lid', phoneNumber: leader });
  expect(JSON.stringify(result)).not.toContain('249900000099');
});
it('resolves only one local invite, verifies its name, then queries its exact JID without joining', async () => {
  const request = parseMetadataRequest({ ...input, groupJid: '', inviteLink: 'https://chat.whatsapp.com/MockPrivateToken123456?mode=gi_t' });
  const query = vi.fn(async () => response());
  const result = await identifyPrivateGroup(request, account, query);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.map(call => (call[0] as BinaryNode).attrs.type)).toEqual(['get', 'get']);
  expect(query.mock.calls[0]?.[0]).toMatchObject({ attrs: { to: '@g.us' }, content: [{ tag: 'invite' }] });
  expect(query.mock.calls[1]?.[0]).toMatchObject({ attrs: { to: gid }, content: [{ tag: 'query' }] });
  expect(JSON.stringify(result)).not.toContain('MockPrivateToken');
});
it.each([
  { groupJid: '', inviteLink: '' }, { inviteLink: 'https://chat.whatsapp.com/MockPrivateToken123456' },
  { groupJid: 'not-a-group' }, { groupJid: '', inviteLink: 'https://evil.example/MockPrivateToken123456' },
  { groupJid: '', inviteLink: 'http://chat.whatsapp.com/MockPrivateToken123456' },
  { groupJid: '', inviteLink: 'https://chat.whatsapp.com/MockPrivateToken123456?secret=x' },
  { leader: 'Display Name' }, { admins: [] }, { admins: [admin, admin] }, { expectedGroupName: '' },
])('fails closed on invalid local target/roles %#', changed => {
  expect(() => parseMetadataRequest({ ...input, ...changed })).toThrow();
});
it('accepts selected international phone numbers without guessing LIDs', () => {
  expect(parseMetadataRequest({ ...input, leader: '+249900000001', admins: ['+249900000002'] })).toMatchObject({ leader, admins: [admin] });
});
it('discards standard WhatsApp sharing parameters from a locally supplied invite', () => {
  const request = parseMetadataRequest({ ...input, groupJid: '', inviteLink: 'https://chat.whatsapp.com/MockPrivateToken123456?s=sh&p=a&mlu=4&ilr=4' });
  expect(request.inviteCode).toBe('MockPrivateToken123456');
  expect(request).not.toHaveProperty('inviteLink');
});
it.each(['wrong-name', 'wrong-group', 'not-member', 'missing-selection', 'duplicate', 'server-error'])('rejects unverifiable target or participant: %s', async scenario => {
  const node = response(scenario === 'wrong-group' ? '120363000000000001@g.us' : gid, scenario === 'wrong-name' ? 'University group' : 'Private pilot');
  const children = (node.content as BinaryNode[])[0]!.content as BinaryNode[];
  if (scenario === 'not-member') children.splice(2, 1);
  if (scenario === 'missing-selection') children.splice(0, 1);
  if (scenario === 'duplicate') children.push(children[0]!);
  if (scenario === 'server-error') node.content = [{ tag: 'error', attrs: { code: '403' } }];
  await expect(identifyPrivateGroup(parseMetadataRequest(input), account, async () => node)).rejects.toThrow();
});
function fakeSocket() {
  const ev = new EventEmitter(); const end = vi.fn(); const query = vi.fn(async (_node: BinaryNode) => response());
  const socket = { ev, end, query, user: account } as unknown as MetadataSocket;
  return { socket, ev, end, query };
}
it('constructs only the base socket, blocks all chat JIDs, and removes automatic pairing handlers', () => {
  const fake = fakeSocket(); const ws = new EventEmitter();
  ws.on('CB:iq,type:set,pair-device', vi.fn()); ws.on('CB:iq,,pair-success', vi.fn());
  base.create.mockReturnValue({ ...fake.socket, ws });
  createMetadataSocket({} as AuthenticationState);
  const config = base.create.mock.calls[0]![0];
  expect(config.shouldIgnoreJid(gid)).toBe(true); expect(config.shouldSyncHistoryMessage({})).toBe(false);
  expect(config.markOnlineOnConnect).toBe(false); expect(config.syncFullHistory).toBe(false);
  expect(ws.listenerCount('CB:iq,type:set,pair-device')).toBe(0); expect(ws.listenerCount('CB:iq,,pair-success')).toBe(0);
});
it('has no chat handler or delivery workers, persists auth updates, and stops automatically', async () => {
  const fake = fakeSocket(); const saves = vi.fn(async () => {}); const workers = vi.spyOn(ReminderWorker.prototype, 'start');
  const task = runMetadataOnly(parseMetadataRequest(input), '249900000003@s.whatsapp.net', { createSocket: () => fake.socket, saveCreds: saves });
  expect(fake.ev.listenerCount('messages.upsert')).toBe(0);
  expect((fake.socket as unknown as Record<string, unknown>).sendMessage).toBeUndefined();
  fake.ev.emit('creds.update', {}); fake.ev.emit('connection.update', { connection: 'open' });
  await expect(task).resolves.toMatchObject({ groupVerified: true });
  expect(saves).toHaveBeenCalledOnce(); expect(workers).not.toHaveBeenCalled(); expect(fake.end).toHaveBeenCalledOnce();
  expect(fake.ev.listenerCount('connection.update')).toBe(0); expect(fake.ev.listenerCount('creds.update')).toBe(0);
});
it.each(['qr', 'wrong-account', 'disconnect', 'cancel', 'timeout', 'save-failure'])('stops without queries on %s', async scenario => {
  vi.useFakeTimers(); const fake = fakeSocket(); const controller = new AbortController();
  const saveCreds = vi.fn(async () => { if (scenario === 'save-failure') throw new Error('private fixture secret'); });
  const task = runMetadataOnly(parseMetadataRequest(input), scenario === 'wrong-account' ? '249900000009@s.whatsapp.net' : '249900000003@s.whatsapp.net', { createSocket: () => fake.socket, saveCreds }, controller.signal);
  const rejected = expect(task).rejects.toThrow();
  if (scenario === 'cancel') controller.abort();
  else if (scenario === 'timeout') await vi.advanceTimersByTimeAsync(90_000);
  else if (scenario === 'save-failure') fake.ev.emit('creds.update', {});
  else fake.ev.emit('connection.update', scenario === 'qr' ? { qr: 'private-mock-only' } : { connection: scenario === 'disconnect' ? 'close' : 'open' });
  await rejected; expect(fake.query).not.toHaveBeenCalled(); expect(fake.end).toHaveBeenCalled();
});
it('discards an in-flight metadata response after cancellation and still closes the connection', async () => {
  const fake = fakeSocket(); const controller = new AbortController();
  let complete!: (node: BinaryNode) => void;
  fake.query.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const task = runMetadataOnly(parseMetadataRequest(input), '249900000003@s.whatsapp.net', { createSocket: () => fake.socket, saveCreds: async () => {} }, controller.signal);
  const rejected = expect(task).rejects.toThrow();
  fake.ev.emit('connection.update', { connection: 'open' });
  await Promise.resolve();
  controller.abort(); complete(response());
  await rejected; expect(fake.end).toHaveBeenCalled();
});
it('stops without saving a result when a targeted metadata query fails', async () => {
  const fake = fakeSocket(); fake.query.mockRejectedValue(new Error('mock private server data'));
  const task = runMetadataOnly(parseMetadataRequest(input), '249900000003@s.whatsapp.net', { createSocket: () => fake.socket, saveCreds: async () => {} });
  const rejected = expect(task).rejects.toThrow();
  fake.ev.emit('connection.update', { connection: 'open' });
  await rejected; expect(fake.end).toHaveBeenCalledOnce();
});
