import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferJSON, type AuthenticationState } from '@whiskeysockets/baileys';
import { pairedSession } from './helpers/paired-session.js';
import type { Socket } from '../src/whatsapp/adapter.js';
import { pairingRuntime } from '../src/pilot/pairing.js';
import { pilotConfig } from '../src/pilot/config.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import { WhatsAppRuntime } from '../src/whatsapp/runtime.js';

const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'pairing-pilot-')); cleanup.push(temp);
  const root = join(temp, 'project');
  const local = join(temp, 'local');
  const auth = join(local, 'AssignmentReminderBot', 'pilot-auth');
  await mkdir(join(root, 'data/pilot'), { recursive: true });
  await writeFile(join(root, 'data/pilot/groups.json'), '[]');
  await writeFile(join(root, 'data/pilot/pilot.sqlite'), '');
  const env = { LOCALAPPDATA: local, WHATSAPP_AUTH_DIR: auth, DATABASE_PATH: 'data/pilot/pilot.sqlite', GROUPS_CONFIG_PATH: 'data/pilot/groups.json',
    WHATSAPP_ENABLE_LIVE: 'false', PILOT_OWNER_CONSENT: 'true', PILOT_AUTH_DIR_APPROVED: 'true', PILOT_AUTH_PERMISSIONS_CONFIRMED: 'true', PILOT_PAIRING_APPROVED: 'true' };
  return { root, auth, env };
}
describe('pairing-only runtime', () => {
  it('never enables a live adapter for the wrong account or after an unexpected QR stops it', async () => {
    for (const unexpectedQr of [false, true]) {
      const ev = new EventEmitter(); const attach = vi.fn(); const send = vi.fn();
      const socket = { ev, sendMessage: send, end: vi.fn() } as unknown as Socket;
      let runtime: WhatsAppRuntime;
      runtime = new WhatsAppRuntime({ attach, authorized: () => false }, {
        loadAuth: async () => ({ state: {} as AuthenticationState, saveCreds: async () => {} }),
        createSocket: () => socket, acceptAccount: () => unexpectedQr,
        qr: () => runtime.stop(), log: vi.fn(),
      });
      try {
        await runtime.start();
        ev.emit('connection.update', { connection: 'open', ...(unexpectedQr ? { qr: 'mock-only' } : {}) });
        expect(attach.mock.calls.some(call => call[1] === true)).toBe(false);
        expect(send).not.toHaveBeenCalled();
      } finally { runtime.stop(); await runtime.idle(); }
    }
  });
  it('renders QR and saves credentials without observing announcements, sending, or starting workers', async () => {
    const ev = new EventEmitter(); const originalSend = vi.fn(); const end = vi.fn();
    const socket = { ev, sendMessage: originalSend, end } as unknown as Socket;
    const worker = vi.spyOn(ReminderWorker.prototype, 'start');
    const saveCreds = vi.fn(async () => {}); const qr = vi.fn();
    const runtime = pairingRuntime({ loadAuth: async () => ({ state: {} as AuthenticationState, saveCreds }), createSocket: () => socket, qr, log: vi.fn() });
    try {
      await runtime.start();
      expect(ev.listenerCount('messages.upsert')).toBe(0);
      ev.emit('connection.update', { qr: 'private-mock-qr', connection: 'open' });
      ev.emit('creds.update', {});
      ev.emit('messages.upsert', { type: 'notify', messages: [{ message: { conversation: 'واجب شبكات 2027-05-20 18:00' } }] });
      await runtime.idle();
      expect(qr).toHaveBeenCalledWith('private-mock-qr'); expect(saveCreds).toHaveBeenCalledOnce();
      await expect(socket.sendMessage('120363000000000000@g.us', { text: 'prohibited' })).rejects.toThrow('prohibited');
      expect(originalSend).not.toHaveBeenCalled(); expect(worker).not.toHaveBeenCalled();
    } finally { runtime.stop(); await runtime.idle(); }
    expect(ev.listenerCount('connection.update')).toBe(0);
  });
  it('remains pairing-only after reconnecting and reuses saved authentication', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = []; const sends = vi.fn(); const loadAuth = vi.fn(async () => ({ state: {} as AuthenticationState, saveCreds: async () => {} }));
    const runtime = pairingRuntime({ loadAuth, createSocket: () => { const s = { ev: new EventEmitter(), sendMessage: sends, end: vi.fn() } as unknown as Socket; sockets.push(s); return s; }, qr: vi.fn(), log: vi.fn() });
    try {
      await runtime.start(); sockets[0]!.ev.emit('connection.update', { connection: 'close' });
      await vi.advanceTimersByTimeAsync(1000); await runtime.idle();
      expect(loadAuth).toHaveBeenCalledTimes(2);
      expect((sockets[1]!.ev as unknown as EventEmitter).listenerCount('messages.upsert')).toBe(0);
      await expect(sockets[1]!.sendMessage('120363000000000000@g.us', { text: 'no' })).rejects.toThrow();
      expect(sends).not.toHaveBeenCalled();
    } finally { runtime.stop(); await runtime.idle(); vi.useRealTimers(); }
  });
});
describe('pilot approval and isolation guards', () => {
  it('allows approved pairing with an empty allowlist without creating authentication', async () => {
    const f = await fixture(); expect((await pilotConfig('pair', f.env, f.root)).groups).toEqual([]);
    await expect(import('node:fs/promises').then(fs => fs.stat(f.auth))).rejects.toThrow();
  });
  it('requires metadata-only approval, signed existing auth, disabled messaging and an empty allowlist', async () => {
    const f = await fixture(); const env = { ...f.env, PILOT_METADATA_APPROVED: 'true' };
    await expect(pilotConfig('metadata', env, f.root)).rejects.toThrow();
    await mkdir(f.auth, { recursive: true }); await writeFile(join(f.auth, 'creds.json'), JSON.stringify(pairedSession(), BufferJSON.replacer));
    expect(await pilotConfig('metadata', env, f.root)).toMatchObject({ groups: [], expectedAccount: '249900000003@s.whatsapp.net' });
    await expect(pilotConfig('metadata', { ...env, PILOT_METADATA_APPROVED: 'false' }, f.root)).rejects.toThrow();
    await expect(pilotConfig('metadata', { ...env, WHATSAPP_ENABLE_LIVE: 'true' }, f.root)).rejects.toThrow();
    await writeFile(join(f.root, 'data/pilot/groups.json'), '[{}]');
    await expect(pilotConfig('metadata', env, f.root)).rejects.toThrow('empty allowlist');
  });
  it.each(['PILOT_OWNER_CONSENT', 'PILOT_AUTH_DIR_APPROVED', 'PILOT_AUTH_PERMISSIONS_CONFIRMED', 'PILOT_PAIRING_APPROVED', 'WHATSAPP_AUTH_DIR', 'LOCALAPPDATA', 'DATABASE_PATH', 'GROUPS_CONFIG_PATH'])('rejects missing %s', async key => {
    const f = await fixture(); const env: NodeJS.ProcessEnv = { ...f.env }; delete env[key];
    await expect(pilotConfig('pair', env, f.root)).rejects.toThrow();
  });
  it('rejects enabled live messaging, populated allowlists and development databases during pairing', async () => {
    const f = await fixture();
    await expect(pilotConfig('pair', { ...f.env, WHATSAPP_ENABLE_LIVE: 'true' }, f.root)).rejects.toThrow();
    await expect(pilotConfig('pair', { ...f.env, DATABASE_PATH: 'data/bot.sqlite' }, f.root)).rejects.toThrow();
    await writeFile(join(f.root, 'data/pilot/groups.json'), '[{}]');
    await expect(pilotConfig('pair', f.env, f.root)).rejects.toThrow('empty allowlist');
  });
  it('requires explicit live approval, one group, disabled mentions, verified identity and registered session', async () => {
    const f = await fixture(); const env = { ...f.env, WHATSAPP_ENABLE_LIVE: 'true', PILOT_LIVE_APPROVED: 'true', PILOT_EXPECTED_ACCOUNT_JID: '249900000003@s.whatsapp.net' };
    await expect(pilotConfig('live', env, f.root)).rejects.toThrow();
    const group = { id: '120363000000000000@g.us', leader: '249900000001@s.whatsapp.net', admins: ['249900000002@s.whatsapp.net'], timezone: 'Africa/Khartoum', reminders: { offsetHours: [24], mentions: 'none' } };
    await writeFile(join(f.root, 'data/pilot/groups.json'), JSON.stringify([group]));
    await expect(pilotConfig('live', env, f.root)).rejects.toThrow();
    await mkdir(f.auth, { recursive: true }); await writeFile(join(f.auth, 'creds.json'), JSON.stringify(pairedSession(), BufferJSON.replacer));
    expect((await pilotConfig('live', env, f.root)).groups).toHaveLength(1);
    for (const changed of [{ PILOT_LIVE_APPROVED: 'false' }, { PILOT_EXPECTED_ACCOUNT_JID: '' }]) {
      await expect(pilotConfig('live', { ...env, ...changed }, f.root)).rejects.toThrow();
    }
    await writeFile(join(f.root, 'data/pilot/groups.json'), JSON.stringify([{ ...group, reminders: { offsetHours: [24], mentions: 'native_all' } }]));
    await expect(pilotConfig('live', env, f.root)).rejects.toThrow('disabled mentions');
    await writeFile(join(f.root, 'data/pilot/groups.json'), JSON.stringify([group, { ...group, id: '120363000000000001@g.us' }]));
    await expect(pilotConfig('live', env, f.root)).rejects.toThrow('exactly one');
  });
});
