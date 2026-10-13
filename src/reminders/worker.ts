import { DateTime } from 'luxon';
import type { Store } from '../database.js';
import type { Assignment, WhatsAppAdapter, SendOptions, ReminderSettings } from '../types.js';
import { assignmentText, messageId, planAssignment, utcAfter, type Job, type SavedAssignment } from './storage.js';

export class ReminderWorker {
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: Store, private adapter: WhatsAppAdapter, private authorized: (group: string) => boolean,
    private now = () => new Date().toISOString(), private leaseMs = 60_000, private log = (event: string) => console.error(`[reminders] ${event}`)) {}
  start(intervalMs = 15_000) {
    if (this.timer) return;
    const run = () => { void this.tick().catch(() => this.log('worker-error')); };
    this.timer = setInterval(run, intervalMs); run();
  }
  async stop() { clearInterval(this.timer); this.timer = undefined; await this.running; }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }
  private claim(): Job | undefined {
    const now = this.now();
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Upgrade-era assignments without jobs have unknown registration times; require late approval if needed.
      const unplanned = db.prepare("SELECT a.id FROM assignments a WHERE a.status='active' AND a.deadline>? AND NOT EXISTS(SELECT 1 FROM reminder_jobs j WHERE j.assignment_id=a.id AND j.version=a.version AND j.kind<>'change')").all(now) as { id: number }[];
      for (const a of unplanned) {
        const saved = db.prepare('SELECT * FROM assignments WHERE id=?').get(a.id) as unknown as SavedAssignment;
        if (this.authorized(saved.group_id)) planAssignment(db, a.id, saved.registered_at ?? now);
      }
      db.prepare("UPDATE reminder_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=?").run(now);
      db.prepare("UPDATE reminder_jobs SET status='expired' WHERE kind<>'change' AND status IN ('pending','awaiting_approval') AND assignment_id IN (SELECT id FROM assignments WHERE deadline<=?)").run(now);
      const candidates = db.prepare("SELECT j.*,a.group_id FROM reminder_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE j.status='pending' AND j.due_at<=? AND j.next_attempt<=? AND a.status='active' AND (j.kind='change' OR a.deadline>?) AND a.version=j.version AND NOT EXISTS(SELECT 1 FROM reminder_jobs busy WHERE busy.assignment_id=a.id AND busy.status='leased') ORDER BY CASE j.kind WHEN 'change' THEN 0 ELSE 1 END,j.due_at DESC,j.id").all(now, now, now) as unknown as (Job & { group_id: string })[];
      const job = candidates.find(j => this.authorized(j.group_id));
      if (job) {
        // After downtime, one most recent overdue reminder replaces older overdue offsets.
        if (job.kind === 'reminder') db.prepare("UPDATE reminder_jobs SET status='skipped' WHERE assignment_id=? AND version=? AND kind='reminder' AND status='pending' AND due_at<=? AND id<>?").run(job.assignment_id, job.version, now, job.id);
        job.lease_token = messageId(); job.lease_until = utcAfter(now, this.leaseMs);
        db.prepare("UPDATE reminder_jobs SET status='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending'").run(job.lease_token, job.lease_until, job.id);
      }
      db.exec('COMMIT'); return job;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  private async process() {
    for (let count = 0; count < 50; count++) {
      const job = this.claim(); if (!job) return;
      const db = this.store.db;
      const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(job.assignment_id) as unknown as SavedAssignment;
      const group = this.store.group(a.group_id)!;
      const data = JSON.parse(a.data) as Assignment;
      const formatted = DateTime.fromISO(a.deadline).setZone(group.timezone).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ');
      const settings = JSON.parse(db.prepare('SELECT reminder_settings FROM groups WHERE id=?').get(a.group_id)!.reminder_settings as string) as ReminderSettings;
      const heartbeat = setInterval(() => {
        try { db.prepare("UPDATE reminder_jobs SET lease_until=? WHERE id=? AND lease_token=? AND status='leased'").run(utcAfter(this.now(), this.leaseMs), job.id, job.lease_token!); }
        catch { this.log('lease-renewal-failed'); }
      }, Math.max(10, Math.floor(this.leaseMs / 3)));
      try {
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
        if (!owned || !this.authorized(a.group_id)) throw new Error('Delivery no longer authorized.');
        const id = await this.adapter.send(a.group_id, text, undefined, options);
        if (id !== job.message_id) throw new Error('Transport did not honor the persistent message ID.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const delivered = db.prepare("UPDATE reminder_jobs SET status='sent',delivered_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='leased'").run(this.now(), job.id, job.lease_token!);
          if (delivered.changes && job.kind === 'change') db.prepare('UPDATE assignment_changes SET delivered=1 WHERE group_id=? AND message_id=?').run(a.group_id, job.message_id);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      } catch {
        const delay = Math.min(300_000, 1000 * 2 ** Math.min(job.attempts, 8));
        db.prepare("UPDATE reminder_jobs SET status='pending',next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=? AND status='leased'").run(utcAfter(this.now(), delay), job.id, job.lease_token!);
        this.log('delivery-retry-scheduled');
      } finally { clearInterval(heartbeat); }
    }
  }
}
