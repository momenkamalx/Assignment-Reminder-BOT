import { DateTime } from 'luxon';
import { Store } from './database.js';
import { extractAssignments, parseDeadline } from './parser.js';
import type { Assignment, IncomingMessage, WhatsAppAdapter } from './types.js';

export function preview(drafts: Assignment[], zone: string): string {
  return drafts.map((d, i) => `${i + 1}. ${d.course ?? 'المادة غير مذكورة'} — ${d.name ?? 'اسم التكليف غير مذكور'}\n${d.description ?? ''}\nالموعد: ${d.deadline ? DateTime.fromISO(d.deadline).setZone(zone).toFormat('yyyy-MM-dd HH:mm ZZZZ') : d.deadlineIssue}\nالتسليم: ${d.submissionMethod ?? 'غير مذكور'} ${d.destination ?? ''}`).join('\n\n') + '\n\nهل تريد تسجيل التكليفات؟\nReply yes / نعم to this message; no / لا to reject.\nEdit by replying: !edit 1 deadline=2027-05-20 18:00';
}

export class Bot {
  // Serialize messages within this process; SQLite transactions also protect separate connections.
  private queue: Promise<void> = Promise.resolve();
  constructor(private store: Store, private adapter: WhatsAppAdapter, private now = () => new Date().toISOString()) {}
  handle(message: IncomingMessage): Promise<void> {
    const task = this.queue.then(() => this.process(message));
    this.queue = task.catch(() => {});
    return task;
  }
  private async process(m: IncomingMessage) {
    const group = this.store.group(m.groupId);
    if (!group) return;
    const text = m.text.trim();
    const send = (content: string) => this.adapter.send(m.groupId, content, m.id);
    if (text === '!help') {
      await send('!list: upcoming assignments. Reply to a preview: yes/نعم/y/يس, no/لا, or !edit NUMBER FIELD=VALUE. Fields: course, name, description, deadline, submissionMethod, destination. Saved assignment changes and !delete arrive in Stage 3.'); return;
    }
    if (text === '!list') {
      const rows = this.store.upcoming(m.groupId, this.now());
      await send(rows.length ? rows.map(row => `${row.id}: ${preview([JSON.parse(row.data) as Assignment], group.timezone).split('\n\nهل')[0]}`).join('\n\n') : 'لا توجد تكليفات قادمة.'); return;
    }
    const isAdmin = (JSON.parse(group.admins) as string[]).includes(m.senderId);
    if (m.replyTo && isAdmin) {
      const pending = this.store.confirmation(m.groupId, m.replyTo);
      if (!pending) return;
      if (/^(نعم|يس|yes|y)$/iu.test(text)) {
        const result = this.store.approve(m.groupId, m.replyTo, this.now());
        await send(result === 'saved' ? 'تم تسجيل التكليفات بنجاح.' : result === 'invalid' ? 'صحح المواعيد المفقودة أو الغامضة أو الماضية قبل التسجيل.' : 'هذا التأكيد لم يعد صالحاً.'); return;
      }
      if (/^(لا|no)$/iu.test(text)) { this.store.reject(m.groupId, pending.original_id); await send('تم رفض التسجيل.'); return; }
      if (text.startsWith('!edit')) {
        const match = text.match(/^!edit\s+(\d+)\s+(course|name|description|deadline|submissionMethod|destination)=(.+)$/s);
        const drafts = JSON.parse(pending.drafts) as Assignment[];
        const index = Number(match?.[1]) - 1;
        if (!match || !drafts[index]) { await send('Use !edit NUMBER FIELD=VALUE, replying to the current preview.'); return; }
        const field = match[2]!; const value = match[3]!.trim();
        if (field === 'deadline') Object.assign(drafts[index]!, parseDeadline(value, group.timezone));
        else Object.assign(drafts[index]!, { [field]: value });
        const newId = await this.adapter.send(m.groupId, preview(drafts, group.timezone), pending.original_id);
        this.store.db.prepare("UPDATE confirmations SET status='invalidated' WHERE group_id=? AND original_id=?").run(m.groupId, pending.original_id);
        this.store.addConfirmation(m.groupId, newId, pending.original_id, drafts); return;
      }
    }
    // Replies and commands are never treated as new leader announcements.
    if (m.replyTo || text.startsWith('!') || m.senderId !== group.leader) return;
    const drafts = extractAssignments(text, group.timezone);
    if (!drafts.length || !this.store.beginAnnouncement(m.groupId, m.id)) return;
    try {
      const id = await this.adapter.send(m.groupId, preview(drafts, group.timezone), m.id);
      this.store.addConfirmation(m.groupId, id, m.id, drafts);
    } catch (error) {
      // No draft was created: allow the transport to retry this announcement.
      this.store.db.prepare("DELETE FROM announcements WHERE group_id=? AND message_id=? AND status='pending'").run(m.groupId, m.id);
      throw error;
    }
  }
}
