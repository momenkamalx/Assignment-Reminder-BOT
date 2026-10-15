import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, MessageReference } from '../types.js';
import { messageId, utcAfter } from '../reminders/storage.js';

export interface Relevance {
  originalId?: string; confirmationId?: string; announcementState?: string; changeId?: string; changeState?: string;
}
export interface Receipt { sourceId: string; replyTo?: string; quote?: MessageReference }
export interface Outgoing {
  id: number; group_id: string; message_id: string; kind: 'preview' | 'success' | 'feedback'; text: string;
  reply_to: string | null; quote_json: string | null; original_id: string | null; confirmation_id: string | null;
  announcement_state: string | null; change_id: string | null; change_state: string | null;
  expires_at: string; status: string; attempts: number; max_attempts: number; lease_token: string | null;
}
export const receiptFor = (m: IncomingMessage): Receipt => ({ sourceId: m.id, replyTo: m.id,
  quote: m.key ?? { id: m.id, remoteJid: m.groupId, participant: m.senderId, fromMe: false } });

/** May be called inside the business transaction; never sends or stores incoming text. */
export function enqueue(db: DatabaseSync, group: string, dedupe: string, kind: Outgoing['kind'], text: string, now: string,
  receipt?: Receipt, relevance: Relevance = {}, stableId = messageId()) {
  db.prepare(`INSERT OR IGNORE INTO outgoing_messages(group_id,dedupe_key,message_id,kind,text,reply_to,quote_json,
    original_id,confirmation_id,announcement_state,change_id,change_state,created_at,expires_at,next_attempt)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(group, dedupe, stableId, kind, text, receipt?.replyTo ?? null,
      receipt?.quote ? JSON.stringify(receipt.quote) : null, relevance.originalId ?? null, relevance.confirmationId ?? null,
      relevance.announcementState ?? null, relevance.changeId ?? null, relevance.changeState ?? null,
      now, kind === 'success' ? '9999-12-31T23:59:59.999Z' : utcAfter(now, kind === 'preview' ? 7 * 86400000 : 86400000), now);
  return db.prepare('SELECT message_id FROM outgoing_messages WHERE group_id=? AND dedupe_key=?').get(group, dedupe)!.message_id as string;
}
export function relevant(db: DatabaseSync, q: Outgoing, now: string): boolean {
  if (q.expires_at <= now) return false;
  if (q.kind === 'preview' && (!q.original_id || !q.confirmation_id || !db.prepare("SELECT message_id FROM confirmations WHERE group_id=? AND message_id=? AND original_id=? AND status='pending'").get(q.group_id, q.confirmation_id, q.original_id))) return false;
  if (q.original_id && q.announcement_state && db.prepare('SELECT status FROM announcements WHERE group_id=? AND message_id=?').get(q.group_id, q.original_id)?.status !== q.announcement_state) return false;
  if (q.confirmation_id && !db.prepare("SELECT message_id FROM confirmations WHERE group_id=? AND message_id=? AND status='pending'").get(q.group_id, q.confirmation_id)) return false;
  if (q.change_id && q.change_state && db.prepare('SELECT status FROM assignment_changes WHERE group_id=? AND message_id=?').get(q.group_id, q.change_id)?.status !== q.change_state) return false;
  if (q.kind === 'success' && !db.prepare("SELECT id FROM assignments WHERE group_id=? AND original_id=? AND status='active' AND deadline>? LIMIT 1").get(q.group_id, q.original_id!, now)) return false;
  return true;
}
export function cancelObsolete(db: DatabaseSync, q: Outgoing, now: string) {
  db.prepare("UPDATE outgoing_messages SET status=?,lease_token=NULL,lease_until=NULL,failure_reason='obsolete' WHERE id=? AND status<>'sent'").run(q.expires_at <= now ? 'expired' : 'cancelled', q.id);
  if (q.kind === 'preview') db.prepare("UPDATE confirmations SET status='invalidated' WHERE group_id=? AND message_id=? AND status='pending'").run(q.group_id, q.confirmation_id!);
}
