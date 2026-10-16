import { DateTime } from 'luxon';
import { Store } from './database.js';
import { extractAssignments, hasAssignmentKeyword, parseDeadline } from './parser.js';
import { diagnostic, noDiagnostics, type DiagnosticSink } from './diagnostics.js';
import type { Assignment, IncomingMessage, WhatsAppAdapter } from './types.js';
import { receiptFor, type Relevance } from './delivery/outbox.js';
import { ReminderWorker } from './reminders/worker.js';

export function preview(drafts: Assignment[], zone: string): string {
  return drafts.map((d, i) => `${i + 1}. ${d.course ?? 'المادة: غير محددة'} — ${d.name ?? 'اسم الواجب: غير محدد'}\n${d.description ?? ''}\nموعد التسليم: ${d.deadline && !d.deadlineIssue ? DateTime.fromISO(d.deadline).setZone(zone).toFormat('yyyy-MM-dd HH:mm ZZZZ') : `يحتاج توضيح (${d.deadlineIssue ?? 'Missing deadline'})`}\nمكان التسليم: ${d.submissionMethod ?? 'غير محدد'} ${d.destination ?? ''}`).join('\n\n') +
    (drafts.some(d => !d.course || !d.name || !d.deadline || d.deadlineIssue || !d.submissionMethod) ? '\nيرجى توضيح البيانات غير المحددة بالرد على هذه المعاينة بأمر !edit. لا يتم التسجيل أو جدولة التذكيرات قبل تصحيح الموعد.' : '') +
    '\n\nهل تريد تسجيل التكليفات؟\nReply yes / نعم to this message; no / لا to reject.\nEdit by replying: !edit 1 deadline=2027-05-20 18:00';
}

export class Bot {
  // Serialize messages within this process; SQLite transactions also protect separate connections.
  private queue: Promise<void> = Promise.resolve();
  private delivery: ReminderWorker;
  constructor(private store: Store, private adapter: WhatsAppAdapter, private now = () => new Date().toISOString(), private diagnostics: DiagnosticSink = noDiagnostics) {
    this.delivery = new ReminderWorker(store, adapter, group => !!store.group(group) && (!adapter.authorized || adapter.authorized(group)), now, 60000, undefined, diagnostics);
  }
  handle(message: IncomingMessage): Promise<void> {
    const task = this.queue.then(() => this.process(message)).then(() => this.delivery.flushOutgoing());
    this.queue = task.catch(() => {});
    return task;
  }
  private async process(m: IncomingMessage) {
    const group = this.store.group(m.groupId);
    if (!group) return;
    const text = m.text.trim();
    const receipt = receiptFor(m);
    const send = async (content: string, scope: Relevance = {}) => this.store.queueReply(m.groupId, content, this.now(), receipt, scope);
    if (text === '!help') {
      await send('!list: upcoming assignments. Draft edits: reply !edit NUMBER FIELD=VALUE. Saved edits: !edit ID FIELD=VALUE; cancellation: !delete ID. Admin confirmation is required. Admin delivery controls: !delivery, !retry MESSAGE_ID. Reply yes/نعم/y/يس or no/لا to the specific preview or immediate-reminder request.'); return;
    }
    if (text === '!list') {
      const rows = this.store.upcoming(m.groupId, this.now());
      await send(rows.length ? rows.map(row => `${row.id}: ${preview([JSON.parse(row.data) as Assignment], group.timezone).split('\n\nهل')[0]}`).join('\n\n') : 'لا توجد تكليفات قادمة.'); return;
    }
    const isAdmin = (JSON.parse(group.admins) as string[]).includes(m.senderId);
    if (isAdmin && text === '!delivery') { await send(JSON.stringify(this.store.deliveryReport(m.groupId))); return; }
    if (isAdmin && /^!retry\s+\S+$/u.test(text)) {
      const ok = this.store.retryDelivery(m.groupId, text.split(/\s+/)[1]!, this.now());
      await send(ok ? 'تمت إعادة جدولة الرسالة بنفس معرفها.' : 'لا توجد رسالة فاشلة صالحة لإعادة المحاولة في هذه المجموعة.'); return;
    }
    if (m.replyTo && isAdmin) {
      if (/^(نعم|يس|yes|y|لا|no)$/iu.test(text)) {
        const approve = /^(نعم|يس|yes|y)$/iu.test(text);
        const result = this.store.confirmChange(m.groupId, m.replyTo, approve, this.now(), receipt);
        if (result !== undefined) {
          return;
        }
        if (this.store.confirmImmediate(m.groupId, m.replyTo, approve, this.now(), receipt)) {
          return;
        }
      }
      const pending = this.store.confirmation(m.groupId, m.replyTo, this.now());
      if (!pending) return;
      if (/^(نعم|يس|yes|y)$/iu.test(text)) {
        const result = this.store.approve(m.groupId, m.replyTo, this.now(), receipt);
        if (result !== 'saved') await send(result === 'invalid' ? 'صحح المواعيد المفقودة أو الغامضة أو الماضية قبل التسجيل.' : 'هذا التأكيد لم يعد صالحاً.',
          { originalId: pending.original_id, confirmationId: m.replyTo, announcementState: 'pending' });
        return;
      }
      if (/^(لا|no)$/iu.test(text)) { this.store.reject(m.groupId, pending.original_id, this.now(), receipt); return; }
      if (text.startsWith('!edit')) {
        const match = text.match(/^!edit\s+(\d+)\s+(course|name|description|deadline|submissionMethod|destination)=(.+)$/s);
        const drafts = JSON.parse(pending.drafts) as Assignment[];
        const index = Number(match?.[1]) - 1;
        if (!match || !drafts[index]) { await send('Use !edit NUMBER FIELD=VALUE, replying to the current preview.'); return; }
        const field = match[2]!; const value = match[3]!.trim();
        if (field === 'deadline') Object.assign(drafts[index]!, parseDeadline(value, group.timezone));
        else Object.assign(drafts[index]!, { [field]: value });
        if (!this.store.replacePreview(m.groupId, m.replyTo, m.id, drafts, preview(drafts, group.timezone), this.now())) await send('تم التعامل مع الإعلان بالفعل؛ هذه المعاينة لم تعد صالحة. استخدم !list للتحقق من التكليفات المسجلة.');
        else diagnostic(this.diagnostics, 'preview_queued', drafts.length);
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
      await send('تم استلام الطلب. انتظر رسالة التأكيد الخاصة بهذا التغيير ثم رد عليها بنعم أو لا.', { changeId: request.message_id, changeState: 'pending' }); return;
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
      if (request && !request.delivered && request.status === 'pending') await send('تم استلام طلب التمديد. يجب أن يؤكده مسؤول بالرد على رسالة التأكيد الخاصة به.', { changeId: request.message_id, changeState: 'pending' });
      return;
    }
    // Replies and commands are never treated as new leader announcements.
    if (m.replyTo || text.startsWith('!') || m.senderId !== group.leader) return;
    diagnostic(this.diagnostics, hasAssignmentKeyword(text) ? 'keyword_detected' : 'keyword_absent');
    diagnostic(this.diagnostics, 'parser_invoked');
    const drafts = extractAssignments(text, group.timezone);
    diagnostic(this.diagnostics, !drafts.length ? 'parser_empty' : drafts.some(d => !d.course || !d.name || !d.deadline || d.deadlineIssue || !d.submissionMethod) ? 'parser_incomplete' : 'parser_accepted', drafts.length);
    if (drafts.length && this.store.queueAnnouncement(m, drafts, preview(drafts, group.timezone), this.now(), receipt)) {
      diagnostic(this.diagnostics, 'draft_created', drafts.length); diagnostic(this.diagnostics, 'preview_queued', drafts.length);
    }
  }
}
