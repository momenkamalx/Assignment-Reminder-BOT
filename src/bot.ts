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
      await send('!list: upcoming assignments. Draft edits: reply !edit NUMBER FIELD=VALUE. Saved edits: !edit ID FIELD=VALUE; cancellation: !delete ID. Admin confirmation is required. Reply yes/نعم/y/يس or no/لا to the specific preview or immediate-reminder request.'); return;
    }
    if (text === '!list') {
      const rows = this.store.upcoming(m.groupId, this.now());
      await send(rows.length ? rows.map(row => `${row.id}: ${preview([JSON.parse(row.data) as Assignment], group.timezone).split('\n\nهل')[0]}`).join('\n\n') : 'لا توجد تكليفات قادمة.'); return;
    }
    const isAdmin = (JSON.parse(group.admins) as string[]).includes(m.senderId);
    if (m.replyTo && isAdmin) {
      if (/^(نعم|يس|yes|y|لا|no)$/iu.test(text)) {
        const approve = /^(نعم|يس|yes|y)$/iu.test(text);
        const result = this.store.confirmChange(m.groupId, m.replyTo, approve, this.now());
        if (result !== undefined) {
          await send(result === 'saved' ? 'تم تأكيد التغيير بنجاح.' : result === 'busy' ? 'تذكير قيد الإرسال؛ أعد التأكيد بعد اكتماله.' : result === 'invalid' ? 'الموعد غير صالح؛ أرسل طلب تعديل جديد.' : result === 'rejected' ? 'تم رفض التغيير.' : 'هذا الطلب لم يعد صالحاً.'); return;
        }
        if (this.store.confirmImmediate(m.groupId, m.replyTo, approve, this.now())) {
          await send(approve ? 'تمت الموافقة على التذكير الفوري.' : 'تم رفض التذكير الفوري.'); return;
        }
      }
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
        if (!this.store.addConfirmation(m.groupId, newId, pending.original_id, drafts)) await send('تم التعامل مع الإعلان بالفعل؛ هذه المعاينة لم تعد صالحة. استخدم !list للتحقق من التكليفات المسجلة.');
        return;
      }
    }
    if (isAdmin && !m.replyTo && (text.startsWith('!edit ') || text.startsWith('!delete '))) {
      const edit = text.match(/^!edit\s+(\d+)\s+(course|name|description|deadline|submissionMethod|destination)=(.+)$/s);
      const cancel = text.match(/^!delete\s+(\d+)$/);
      const id = Number(edit?.[1] ?? cancel?.[1]);
      const saved = this.store.assignment(m.groupId, id);
      if ((!edit && !cancel) || !saved) { await send('Use !edit ID FIELD=VALUE or !delete ID for an active assignment in this group.'); return; }
      const data = JSON.parse(saved.data) as Assignment;
      if (edit) {
        if (edit[2] === 'deadline') Object.assign(data, parseDeadline(edit[3]!, group.timezone));
        else Object.assign(data, { [edit[2]!]: edit[3]!.trim() });
        if (!data.deadline || data.deadlineIssue || data.deadline <= this.now()) { await send('صحح الموعد: YYYY-MM-DD HH:mm ويجب أن يكون في المستقبل.'); return; }
      }
      const request = this.store.requestChange(m.groupId, m.id, id, cancel ? 'cancel' : 'update', data, this.now());
      if (!request || request.delivered || request.status !== 'pending') return;
      await send('تم استلام الطلب. انتظر رسالة التأكيد الخاصة بهذا التغيير ثم رد عليها بنعم أو لا.'); return;
    }
    // A leader can propose an extension, but cannot bypass the separate admin confirmation.
    if (!m.replyTo && m.senderId === group.leader && /تم\s+(?:تمديد|تأجيل)|(?:التسليم|الموعد)\s+(?:اتمدد|تمدد|اتأجل)|\bdeadline\s+(?:extended|extension)\b/iu.test(text)) {
      if (this.store.db.prepare('SELECT message_id FROM assignment_changes WHERE group_id=? AND source_id=?').get(m.groupId, m.id)) return;
      const normalized = text.replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)));
      const references = [...normalized.matchAll(/(?:التكليف|تكليف|assignment|الواجب|واجب|التمرين|تمرين|المشروع|مشروع)\s*#?\s*(\d+)/giu)];
      const id = references.length === 1 ? Number(references[0]![1]) : NaN;
      const saved = this.store.assignment(m.groupId, id);
      if (!saved) { await send('حدد رقم تكليف واحد من !list، مثلاً: تم تمديد تسليم التكليف #12 إلى 2027-05-20 18:00.'); return; }
      const deadline = parseDeadline(text, group.timezone);
      if (!deadline.deadline || deadline.deadlineIssue || deadline.deadline <= this.now() || deadline.deadline <= saved.deadline) {
        await send('حدد موعد تمديد واحداً بصيغة YYYY-MM-DD HH:mm، بعد الموعد الحالي وفي المستقبل.'); return;
      }
      const data: Assignment = { ...JSON.parse(saved.data) as Assignment, ...deadline };
      const request = this.store.requestChange(m.groupId, m.id, id, 'update', data, this.now());
      if (request && !request.delivered && request.status === 'pending') await send('تم استلام طلب التمديد. يجب أن يؤكده مسؤول بالرد على رسالة التأكيد الخاصة به.');
      return;
    }
    // Replies and commands are never treated as new leader announcements.
    if (m.replyTo || text.startsWith('!') || m.senderId !== group.leader) return;
    const drafts = extractAssignments(text, group.timezone);
    if (!drafts.length || !this.store.beginAnnouncement(m.groupId, m.id)) return;
    try {
      const id = await this.adapter.send(m.groupId, preview(drafts, group.timezone), m.id);
      if (!this.store.addConfirmation(m.groupId, id, m.id, drafts)) await send('تم التعامل مع الإعلان بالفعل. استخدم !list للتحقق من التكليفات المسجلة.');
    } catch (error) {
      // No draft was created: allow the transport to retry this announcement.
      this.store.db.prepare("DELETE FROM announcements WHERE group_id=? AND message_id=? AND status='pending'").run(m.groupId, m.id);
      throw error;
    }
  }
}
