import { jidNormalizedUser, normalizeMessageContent, type WAMessage, type WASocket, type BaileysEventMap } from '@whiskeysockets/baileys';
import { Bot } from '../bot.js';
import { extractAssignments } from '../parser.js';
import type { Store } from '../database.js';
import type { WhatsAppAdapter, SendOptions } from '../types.js';
import { isGroupId, type GroupConfig } from './config.js';
import { PermanentDeliveryError } from '../delivery/engine.js';
import { diagnostic, noDiagnostics, type DiagnosticSink } from '../diagnostics.js';

export type Socket = Pick<WASocket, 'ev' | 'sendMessage' | 'end' | 'user'> & Partial<Pick<WASocket, 'groupMetadata'>>;
export class BaileysAdapter implements WhatsAppAdapter {
  private socket?: Socket;
  private connected = false;
  private current = new Map<string, WAMessage>();
  readonly bot: Bot;
  constructor(private store: Store, private groups: GroupConfig[], now?: () => string, private diagnostics: DiagnosticSink = noDiagnostics) {
    this.bot = new Bot(store, this, now, diagnostics);
  }
  authorized(jid: string) { return isGroupId(jid) && this.groups.some(g => g.id === jid); }
  ready(jid: string) { return this.authorized(jid) && this.connected && !!this.socket; }
  attach(socket?: Socket, connected = false) { this.socket = socket; this.connected = connected; }
  async receive(event: BaileysEventMap['messages.upsert']) {
    diagnostic(this.diagnostics, event.type === 'notify' ? 'adapter_upsert_notify' : event.type === 'append' ? 'adapter_upsert_append' : 'adapter_upsert_other');
    if (!this.connected || !this.socket) { diagnostic(this.diagnostics, 'adapter_disconnected'); return; }
    if (event.type !== 'notify') return;
    for (const raw of event.messages) {
      const key = raw?.key;
      if (!key || typeof key.remoteJid !== 'string') { diagnostic(this.diagnostics, 'message_key_invalid'); continue; }
      if (!key.remoteJid || !this.authorized(key.remoteJid)) { diagnostic(this.diagnostics, 'group_rejected'); continue; }
      diagnostic(this.diagnostics, 'message_received'); diagnostic(this.diagnostics, 'group_matched');
      // Check routing before looking at the message body or retaining anything.
      if (key.fromMe) { diagnostic(this.diagnostics, 'self_message_rejected'); continue; }
      if (typeof key.id !== 'string' || !key.id || typeof key.participant !== 'string' || !key.participant ||
          (key.participantAlt != null && typeof key.participantAlt !== 'string')) { diagnostic(this.diagnostics, 'message_key_invalid'); continue; }
      const group = this.groups.find(g => g.id === key.remoteJid)!;
      const identities = [key.participant, key.participantAlt].filter((v): v is string => !!v).map(jidNormalizedUser);
      const permitted = [group.leader, ...group.admins];
      const roles = [...new Set(identities.filter(id => permitted.includes(id)))];
      if (roles.length > 1) continue; // Conflicting identity mapping: fail closed.
      const senderId = roles[0] ?? identities[0]!;
      diagnostic(this.diagnostics, senderId === group.leader ? 'leader_matched' : 'leader_rejected');
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
        await this.bot.handle({ id: key.id, groupId: group.id, senderId, text, replyTo: context?.stanzaId ?? undefined,
          key: { id: key.id, remoteJid: group.id, participant: key.participant, participantAlt: key.participantAlt, fromMe: false } });
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
      if (options?.quote && (options.quote.remoteJid !== groupId || options.quote.id !== replyTo)) throw new PermanentDeliveryError('quote_reference_mismatch');
      if (!quoted && options?.quote) quoted = { key: options.quote, message: { conversation: '' } };
      if (!quoted) {
        const row = this.store.db.prepare('SELECT key_json FROM whatsapp_keys WHERE group_id=? AND message_id=?').get(groupId, replyTo);
        if (!row) throw new PermanentDeliveryError('quote_reference_missing', 'Original message key unavailable; refusing an unquoted confirmation.');
        quoted = { key: JSON.parse(row.key_json as string), message: { conversation: '' } };
      }
    }
    const result = await this.socket.sendMessage(groupId, { text, mentions: options?.mentions, mentionAll: options?.mentionAll }, { ...(quoted ? { quoted } : {}), ...(options?.messageId ? { messageId: options.messageId } : {}) });
    if (!result?.key.id) throw new Error('WhatsApp did not return a message ID.');
    return result.key.id;
  }
}
