import { jidNormalizedUser, normalizeMessageContent, type WAMessage, type WASocket, type BaileysEventMap } from '@whiskeysockets/baileys';
import { Bot } from '../bot.js';
import { extractAssignments } from '../parser.js';
import type { Store } from '../database.js';
import type { WhatsAppAdapter, SendOptions } from '../types.js';
import { isGroupId, type GroupConfig } from './config.js';

export type Socket = Pick<WASocket, 'ev' | 'sendMessage' | 'end' | 'user'> & Partial<Pick<WASocket, 'groupMetadata'>>;
export class BaileysAdapter implements WhatsAppAdapter {
  private socket?: Socket;
  private connected = false;
  private current = new Map<string, WAMessage>();
  readonly bot: Bot;
  constructor(private store: Store, private groups: GroupConfig[], now?: () => string) {
    this.bot = new Bot(store, this, now);
  }
  authorized(jid: string) { return isGroupId(jid) && this.groups.some(g => g.id === jid); }
  attach(socket?: Socket, connected = false) { this.socket = socket; this.connected = connected; }
  async receive(event: BaileysEventMap['messages.upsert']) {
    if (event.type !== 'notify' || !this.connected || !this.socket) return;
    for (const raw of event.messages) {
      const { key } = raw;
      // Check routing before looking at the message body or retaining anything.
      if (!key.remoteJid || !this.authorized(key.remoteJid) || key.fromMe || !key.id || !key.participant) continue;
      const group = this.groups.find(g => g.id === key.remoteJid)!;
      const identities = [key.participant, key.participantAlt].filter((v): v is string => !!v).map(jidNormalizedUser);
      const permitted = [group.leader, ...group.admins];
      const roles = [...new Set(identities.filter(id => permitted.includes(id)))];
      if (roles.length > 1) continue; // Conflicting identity mapping: fail closed.
      const senderId = roles[0] ?? identities[0]!;
      const content = normalizeMessageContent(raw.message);
      const extended = content?.extendedTextMessage;
      const text = content?.conversation ?? extended?.text;
      if (!text) continue; // No media downloads, polls, protocol messages, or edits.
      const context = extended?.contextInfo;
      const own = [this.socket.user?.id, this.socket.user?.lid].filter((v): v is string => !!v).map(jidNormalizedUser);
      // Quoted message identity comes from the bot's session, not display names.
      if (context?.stanzaId && (!context.participant || !own.includes(jidNormalizedUser(context.participant)) || (context.remoteJid && context.remoteJid !== group.id))) continue;
      if (!roles.length && text !== '!list' && text !== '!help') continue;
      const cacheId = `${group.id}/${key.id}`;
      this.current.set(cacheId, raw);
      try {
        if (senderId === group.leader && !context?.stanzaId && !text.startsWith('!') && extractAssignments(text, group.timezone).length) {
          this.store.db.prepare('INSERT OR IGNORE INTO whatsapp_keys(group_id,message_id,key_json) VALUES(?,?,?)').run(group.id, key.id, JSON.stringify(key));
        }
        await this.bot.handle({ id: key.id, groupId: group.id, senderId, text, replyTo: context?.stanzaId ?? undefined });
      } finally { this.current.delete(cacheId); }
    }
  }
  async members(groupId: string): Promise<string[]> {
    if (!this.authorized(groupId) || !this.connected || !this.socket?.groupMetadata) throw new Error('Authorized group member lookup unavailable.');
    const metadata = await this.socket.groupMetadata(groupId);
    if (metadata.id !== groupId) throw new Error('Group metadata identity mismatch.');
    return metadata.participants.map(p => jidNormalizedUser(p.id)).filter(id => /^\d+@(s\.whatsapp\.net|lid)$/.test(id));
  }
  async send(groupId: string, text: string, replyTo?: string, options?: SendOptions): Promise<string> {
    if (!this.authorized(groupId)) throw new Error('Refusing delivery outside the authorized group allowlist.');
    if (!this.socket || !this.connected) throw new Error('WhatsApp transport is disconnected.');
    let quoted: WAMessage | undefined;
    if (replyTo) {
      quoted = this.current.get(`${groupId}/${replyTo}`);
      if (!quoted) {
        const row = this.store.db.prepare('SELECT key_json FROM whatsapp_keys WHERE group_id=? AND message_id=?').get(groupId, replyTo);
        if (!row) throw new Error('Original message key is unavailable; refusing an unquoted confirmation.');
        quoted = { key: JSON.parse(row.key_json as string), message: { conversation: '' } };
      }
    }
    const result = await this.socket.sendMessage(groupId, { text, mentions: options?.mentions, mentionAll: options?.mentionAll }, { ...(quoted ? { quoted } : {}), ...(options?.messageId ? { messageId: options.messageId } : {}) });
    if (!result?.key.id) throw new Error('WhatsApp did not return a message ID.');
    return result.key.id;
  }
}
