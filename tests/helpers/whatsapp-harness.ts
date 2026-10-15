import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DisconnectReason, generateWAMessage, initAuthCreds, type WAMessage, type AnyMessageContent, type MiscMessageGenerationOptions, type AuthenticationState } from '@whiskeysockets/baileys';
import { Store } from '../../src/database.js';
import { BaileysAdapter, type Socket } from '../../src/whatsapp/adapter.js';
import { WhatsAppRuntime } from '../../src/whatsapp/runtime.js';
import { applyGroups, parseGroups, type GroupConfig } from '../../src/whatsapp/config.js';
import { ReminderWorker } from '../../src/reminders/worker.js';
import type { Assignment } from '../../src/types.js';
import { expectedAssignments, missingDeadlineAnnouncement, sudaneseAnnouncement } from '../fixtures/sudanese-announcement.js';

const group = '120363000000000001@g.us', otherGroup = '120363000000000002@g.us';
const leader = '249900000001@s.whatsapp.net', admin = '249900000002@s.whatsapp.net', admin2 = '249900000003@s.whatsapp.net';
const student = '249900000004@s.whatsapp.net', self = '249900000005@s.whatsapp.net';
const otherLeader = '249900000006@s.whatsapp.net', otherAdmin = '249900000007@s.whatsapp.net';
const textOf = (m: WAMessage) => m.message?.extendedTextMessage?.text ?? m.message?.conversation ?? '';
type Outgoing = { group: string; message: WAMessage; options: MiscMessageGenerationOptions; content: AnyMessageContent };

/** No real socket factory. SDK message serialization is local; uploads are forbidden. */
class FakeSocket {
  ev = new EventEmitter();
  user = { id: self, lid: '555@lid' };
  end = vi.fn();
  constructor(private app: Harness) {}
  groupMetadata = vi.fn(async (id: string) => ({ id, participants: (this.app.members.get(id) ?? []).map(id => ({ id })) }));
  sendMessage = vi.fn(async (chat: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}): Promise<WAMessage> => {
    const message = await generateWAMessage(chat, { ...content, linkPreview: null } as AnyMessageContent, {
      ...options, timestamp: new Date(this.app.now), userJid: self, logger: pino({ level: 'silent' }),
      upload: async () => { throw new Error('Offline test must never upload.'); },
    });
    const outgoing = { group: chat, message, options, content };
    this.app.attempts.push(outgoing);
    if (this.app.beforeNextDelivery) { const hook = this.app.beforeNextDelivery; this.app.beforeNextDelivery = undefined; await hook(outgoing); }
    if (this.app.disconnectDuringNextSend) {
      this.app.disconnectDuringNextSend = false;
      this.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionClosed } } } });
      throw new Error('Simulated socket closed during delivery');
    }
    // Simulated transport deduplication is intentional, not a claim about WhatsApp servers.
    if (!this.app.delivered.some(m => m.group === chat && m.message.key.id === message.key.id)) this.app.delivered.push(outgoing);
    if (this.app.loseNextAcknowledgement) { this.app.loseNextAcknowledgement = false; throw new Error('Simulated acknowledgement lost after delivery'); }
    return message;
  });
  asSocket() { return this as unknown as Socket; }
}
class Harness {
  readonly folder = mkdtempSync(join(tmpdir(), 'assignment-bot-e2e-'));
  readonly path = join(this.folder, 'bot.sqlite');
  now = '2027-05-15T00:00:00.000Z';
  delivered: Outgoing[] = [];
  attempts: Outgoing[] = [];
  members = new Map([[group, [leader, admin, student]], [otherGroup, [otherLeader, otherAdmin]]]);
  disconnectDuringNextSend = false;
  loseNextAcknowledgement = false;
  beforeNextDelivery?: (outgoing: Outgoing) => Promise<void>;
  configs: GroupConfig[] = parseGroups([
    { id: group, leader, admins: [admin, admin2], timezone: 'Africa/Khartoum' },
    { id: otherGroup, leader: otherLeader, admins: [otherAdmin], timezone: 'Africa/Khartoum' },
  ]);
  store!: Store;
  adapter!: BaileysAdapter;
  runtime!: WhatsAppRuntime;
  worker!: ReminderWorker;
  socket!: FakeSocket;
  private counter = 0;
  private auth: AuthenticationState = { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } };
  clock = () => this.now;
  async start() {
    this.store = new Store(this.path); applyGroups(this.store, this.configs);
    this.adapter = new BaileysAdapter(this.store, this.configs, this.clock);
    this.runtime = new WhatsAppRuntime(this.adapter, {
      loadAuth: async () => ({ state: this.auth, saveCreds: async () => {} }),
      createSocket: () => { this.socket = new FakeSocket(this); return this.socket.asSocket(); },
      qr: () => { throw new Error('No pairing allowed in E2E tests'); }, log: () => {},
    });
    this.worker = new ReminderWorker(this.store, this.adapter, id => this.adapter.authorized(id), this.clock, 60000, () => {});
    await this.runtime.start(); this.socket.ev.emit('connection.update', { connection: 'open' });
  }
  raw(text: string, sender = leader, chat = group, quote?: string, quoteAuthor = self): WAMessage {
    return { key: { remoteJid: chat, participant: sender, fromMe: false, id: `incoming-${++this.counter}` },
      message: quote ? { extendedTextMessage: { text, contextInfo: { stanzaId: quote, participant: quoteAuthor, remoteJid: chat } } } : { conversation: text } };
  }
  async emit(raw: WAMessage, runtime = this.runtime, socket = this.socket) {
    socket.ev.emit('messages.upsert', { type: 'notify', messages: [raw] }); await runtime.idle();
  }
  async send(text: string, sender = leader, chat = group, quote?: string, quoteAuthor = self) { await this.emit(this.raw(text, sender, chat, quote, quoteAuthor)); }
  last() { return this.delivered.at(-1)!; }
  saved(chat = group): Assignment[] { return this.store.upcoming(chat, this.now).map(row => JSON.parse(row.data) as Assignment); }
  reminders() { return this.delivered.filter(m => textOf(m.message).startsWith('تذكير بالتكليف')); }
  async register(text = sudaneseAnnouncement, chat = group) {
    const original = this.raw(text, chat === group ? leader : otherLeader, chat); await this.emit(original);
    const preview = this.last(); await this.send('نعم', chat === group ? admin : otherAdmin, chat, preview.message.key.id!);
    return { original, preview };
  }
  async restart() { await this.close(false); await this.start(); }
  async close(remove = true) {
    this.runtime?.stop(); await this.runtime?.idle(); await this.worker?.stop(); this.store?.close();
    if (remove) rmSync(this.folder, { recursive: true, force: true });
  }
}

export { group, otherGroup, leader, admin, admin2, student, self, otherLeader, otherAdmin, textOf, FakeSocket, Harness };
