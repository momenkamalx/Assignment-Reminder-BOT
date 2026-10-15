import { DateTime } from 'luxon';
import type { Store } from '../database.js';
import type { Assignment, WhatsAppAdapter, SendOptions, ReminderSettings } from '../types.js';
import { assignmentText, messageId, planAssignment, utcAfter, type Job, type SavedAssignment } from './storage.js';
import { DeliveryEngine, ObsoleteDeliveryError, type DeliveryClaim } from '../delivery/engine.js';
import { relevant, cancelObsolete, type Outgoing } from '../delivery/outbox.js';
import { noDiagnostics, type DiagnosticSink } from '../diagnostics.js';

export class ReminderWorker {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private engine: DeliveryEngine;
  constructor(private store: Store, private adapter: WhatsAppAdapter, private authorized: (group: string) => boolean,
    private now = () => new Date().toISOString(), private leaseMs = 60_000, private log = (event: string) => console.error(`[delivery] ${event}`), diagnostics: DiagnosticSink = noDiagnostics) {
    this.engine = new DeliveryEngine(store.db, now, leaseMs, log, diagnostics);
  }
  private available(group: string) { return this.authorized(group) && (!this.adapter.ready || this.adapter.ready(group)); }
  start(intervalMs = 15_000) {
    if (this.timer) return;
    if (this.store.db.prepare("SELECT id FROM outgoing_messages WHERE status='failed' LIMIT 1").get()) this.log('delivery-failures-awaiting-review');
    const run = () => { void this.tick().catch(() => this.log('worker-error')); };
    this.timer = setInterval(run, intervalMs); run();
  }
  async stop() { clearInterval(this.timer); this.timer = undefined; await this.running; }
  tick(onlyJobId?: number): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process(false, onlyJobId).finally(() => { this.running = undefined; });
    return this.running;
  }
  flushOutgoing(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process(true).finally(() => { this.running = undefined; });
    return this.running;
  }
  private claimOutgoing(): Outgoing | undefined {
    const db = this.store.db, now = this.now();
    const groups = (db.prepare('SELECT id FROM groups').all() as { id: string }[]).map(g => g.id).filter(id => this.available(id));
    if (!groups.length) return;
    const placeholders = groups.map(() => '?').join(',');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE outgoing_messages SET status='pending',lease_token=NULL,lease_until=NULL WHERE group_id IN (${placeholders}) AND status='sending' AND lease_until<=?`).run(...groups, now);
      const exhausted = db.prepare(`UPDATE outgoing_messages SET status='failed',failure_reason='retry_exhausted',failed_at=? WHERE group_id IN (${placeholders}) AND status='pending' AND attempts>=max_attempts`).run(now, ...groups);
      if (exhausted.changes) this.log('delivery-failures-awaiting-review');
      db.prepare("UPDATE confirmations SET delivery_error='retry_exhausted' WHERE (group_id,message_id) IN (SELECT group_id,confirmation_id FROM outgoing_messages WHERE status='failed' AND failure_reason='retry_exhausted')").run();
      let claimed: Outgoing | undefined;
      for (let count = 0; count < 50; count++) {
        const q = db.prepare(`SELECT * FROM outgoing_messages WHERE group_id IN (${placeholders}) AND status='pending' AND next_attempt<=? ORDER BY created_at,id LIMIT 1`).get(...groups, now) as unknown as Outgoing | undefined;
        if (!q) break;
        if (!relevant(db, q, now)) { cancelObsolete(db, q, now); continue; }
        q.lease_token = messageId(); q.attempts++;
        db.prepare("UPDATE outgoing_messages SET status='sending',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='pending'").run(q.lease_token, utcAfter(now, this.leaseMs), q.id);
        claimed = q; break;
      }
      db.exec('COMMIT'); return claimed;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private claim(onlyJobId?: number): Job | undefined {
    const now = this.now();
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (onlyJobId === undefined) {
      // Upgrade-era assignments without jobs have unknown registration times; require late approval if needed.
      const unplanned = db.prepare("SELECT a.id FROM assignments a WHERE a.status='active' AND a.deadline>? AND NOT EXISTS(SELECT 1 FROM reminder_jobs j WHERE j.assignment_id=a.id AND j.version=a.version AND j.kind<>'change')").all(now) as { id: number }[];
      for (const a of unplanned) {
        const saved = db.prepare('SELECT * FROM assignments WHERE id=?').get(a.id) as unknown as SavedAssignment;
        if (this.available(saved.group_id)) planAssignment(db, a.id, saved.registered_at ?? now);
      }
      db.prepare("UPDATE reminder_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=?").run(now);
      db.prepare("UPDATE reminder_jobs SET status='failed',failure_reason='retry_exhausted',failed_at=? WHERE status='pending' AND attempts>=max_attempts").run(now);
      db.prepare("UPDATE reminder_jobs SET status='expired' WHERE kind<>'change' AND status IN ('pending','awaiting_approval') AND assignment_id IN (SELECT id FROM assignments WHERE deadline<=?)").run(now);
      }
      const candidates = db.prepare("SELECT j.*,a.group_id FROM reminder_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE j.status='pending' AND j.attempts<j.max_attempts AND j.due_at<=? AND j.next_attempt<=? AND a.status='active' AND (j.kind='change' OR a.deadline>?) AND a.version=j.version AND NOT EXISTS(SELECT 1 FROM reminder_jobs busy WHERE busy.assignment_id=a.id AND busy.status='leased') ORDER BY CASE j.kind WHEN 'change' THEN 0 ELSE 1 END,j.due_at DESC,j.id").all(now, now, now) as unknown as (Job & { group_id: string })[];
      const job = candidates.find(j => this.available(j.group_id) && (onlyJobId === undefined || j.id === onlyJobId));
      if (job) {
        // After downtime, one most recent overdue reminder replaces older overdue offsets.
        if (onlyJobId === undefined && job.kind === 'reminder') db.prepare("UPDATE reminder_jobs SET status='skipped' WHERE assignment_id=? AND version=? AND kind='reminder' AND status='pending' AND due_at<=? AND id<>?").run(job.assignment_id, job.version, now, job.id);
        job.lease_token = messageId(); job.lease_until = utcAfter(now, this.leaseMs);
        db.prepare("UPDATE reminder_jobs SET status='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(job.lease_token, job.lease_until, job.id);
        job.attempts++;
      }
      db.exec('COMMIT'); return job;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private async process(outgoingOnly: boolean, onlyJobId?: number) {
    for (let count = 0; count < 50; count++) {
      const q = this.claimOutgoing();
      if (q) { await this.sendOutgoing(q); continue; }
      if (outgoingOnly) return;
      const job = this.claim(onlyJobId); if (!job) return;
      const db = this.store.db;
      const claim: DeliveryClaim = { table: 'reminder_jobs', id: job.id, token: job.lease_token!, attempts: job.attempts, maxAttempts: job.max_attempts, messageId: job.message_id };
      await this.engine.deliver(claim, async () => {
      const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(job.assignment_id) as unknown as SavedAssignment;
      const group = this.store.group(a.group_id)!;
      const data = JSON.parse(a.data) as Assignment;
      const formatted = DateTime.fromISO(a.deadline).setZone(group.timezone).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
      const settings = JSON.parse(db.prepare('SELECT reminder_settings FROM groups WHERE id=?').get(a.group_id)!.reminder_settings as string) as ReminderSettings;
        let text = assignmentText(data, a.deadline, group.timezone, a.id, formatted);
        const options: SendOptions = { messageId: job.message_id };
        if (job.kind === 'approval') text = `تم التسجيل قبل الموعد بأقل من 24 ساعة. هل توافق على إرسال تذكير فوري؟\n${text}\nReply نعم / yes / y / يس to THIS message to approve, or لا / no to decline.`;
        else if (job.kind === 'change') {
          const change = db.prepare('SELECT action,data FROM assignment_changes WHERE group_id=? AND message_id=?').get(a.group_id, job.message_id)!;
          const proposed = JSON.parse(change.data as string) as Assignment;
          const proposedTime = DateTime.fromISO(proposed.deadline!).setZone(group.timezone).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
          text = `${change.action === 'cancel' ? 'هل تؤكد إلغاء التكليف' : 'هل تؤكد تعديل التكليف'} #${a.id}؟\n${assignmentText(proposed, proposed.deadline!, group.timezone, a.id, proposedTime)}\nReply نعم / yes / y / يس to THIS message to confirm; لا / no to reject.`;
        }
        else if (settings.mentions === 'native_all') { options.mentionAll = true; text += '\n@all'; }
        else if (settings.mentions === 'individual') {
          if (!this.adapter.members) throw new Error('Group member lookup unavailable.');
          options.mentions = [...new Set(await this.adapter.members(a.group_id))];
          text += '\n' + options.mentions.map(jid => `@${jid.split('@')[0]}`).join(' ');
        }
        // Recheck lease/assignment/authorization immediately before the network side effect.
        const owned = db.prepare("SELECT j.id FROM reminder_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE j.id=? AND j.lease_token=? AND j.status='leased' AND j.lease_until>? AND a.version=j.version AND a.status='active' AND (j.kind='change' OR a.deadline>?)").get(job.id, job.lease_token!, this.now(), this.now());
        if (!owned) {
          db.prepare("UPDATE reminder_jobs SET status='expired',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='leased' AND assignment_id IN (SELECT id FROM assignments WHERE deadline<=?)").run(job.id, job.lease_token!, this.now());
          throw new ObsoleteDeliveryError();
        }
        if (!this.available(a.group_id)) throw new Error('Transport unavailable.');
        return this.adapter.send(a.group_id, text, undefined, options);
      }, () => {
        if (job.kind === 'change') db.prepare('UPDATE assignment_changes SET delivered=1 WHERE message_id=?').run(job.message_id);
      });
    }
  }
  private async sendOutgoing(q: Outgoing) {
    const claim: DeliveryClaim = { table: 'outgoing_messages', id: q.id, token: q.lease_token!, attempts: q.attempts, maxAttempts: q.max_attempts, messageId: q.message_id };
    await this.engine.deliver(claim, async () => {
      if (!this.engine.owns(claim)) throw new ObsoleteDeliveryError();
      if (!relevant(this.store.db, q, this.now())) { cancelObsolete(this.store.db, q, this.now()); throw new ObsoleteDeliveryError(); }
      if (!this.available(q.group_id)) throw new Error('Transport unavailable.');
      return this.adapter.send(q.group_id, q.text, q.reply_to ?? undefined,
        { messageId: q.message_id, ...(q.quote_json ? { quote: JSON.parse(q.quote_json) } : {}) });
    }, () => {
      if (q.kind === 'preview') this.store.db.prepare("UPDATE confirmations SET delivered=1,delivery_error=NULL WHERE group_id=? AND message_id=? AND status='pending'").run(q.group_id, q.confirmation_id!);
    });
  }
}
