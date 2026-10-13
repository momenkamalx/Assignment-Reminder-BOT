import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Assignment, ReminderSettings } from './types.js';
import { migrations } from './migrations.js';
import { planAssignment, validateSettings, messageId, type SavedAssignment } from './reminders/storage.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)');
    for (const migration of migrations) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare('SELECT version FROM migrations WHERE version=?').get(migration.version)) {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO migrations VALUES(?)').run(migration.version);
        }
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    }
  }
  configureGroup(id: string, leader: string, admins: string[], timezone = 'Africa/Khartoum') {
    this.db.prepare('INSERT INTO groups(id,leader,admins,timezone) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET leader=excluded.leader, admins=excluded.admins, timezone=excluded.timezone').run(id, leader, JSON.stringify(admins), timezone);
  }
  group(id: string) {
    return this.db.prepare('SELECT * FROM groups WHERE id=?').get(id) as { id: string; leader: string; admins: string; timezone: string } | undefined;
  }
  confirmation(group: string, id: string) {
    return this.db.prepare('SELECT * FROM confirmations WHERE group_id=? AND message_id=? AND status=\'pending\'').get(group, id) as { original_id: string; drafts: string } | undefined;
  }
  beginAnnouncement(group: string, original: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO announcements(group_id,message_id) VALUES(?,?)').run(group, original).changes === 1;
  }
  addConfirmation(group: string, id: string, original: string, drafts: Assignment[]) {
    // The transport await can overlap approval/rejection through another connection.
    // A single guarded write prevents a late preview from reopening a completed announcement.
    return this.db.prepare("INSERT INTO confirmations(group_id,message_id,original_id,drafts) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM announcements WHERE group_id=? AND message_id=? AND status='pending')").run(group, id, original, JSON.stringify(drafts), group, original).changes === 1;
  }
  approve(group: string, confirmationId: string, now: string): 'saved' | 'stale' | 'invalid' {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.confirmation(group, confirmationId);
      if (!pending) { this.db.exec('COMMIT'); return 'stale'; }
      const drafts = JSON.parse(pending.drafts) as Assignment[];
      if (!drafts.length || drafts.some(d => !d.deadline || d.deadlineIssue || d.deadline <= now)) { this.db.exec('COMMIT'); return 'invalid'; }
      const claimed = this.db.prepare("UPDATE announcements SET status='approved' WHERE group_id=? AND message_id=? AND status='pending'").run(group, pending.original_id);
      if (!claimed.changes) { this.db.exec('COMMIT'); return 'stale'; }
      drafts.forEach((draft, index) => {
        const row = this.db.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline,registered_at) VALUES(?,?,?,?,?,?)').run(group, pending.original_id, index + 1, JSON.stringify(draft), draft.deadline!, now);
        planAssignment(this.db, Number(row.lastInsertRowid), now);
      });
      this.db.prepare("UPDATE confirmations SET status='invalidated' WHERE group_id=? AND original_id=?").run(group, pending.original_id);
      this.db.exec('COMMIT'); return 'saved';
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reject(group: string, original: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE announcements SET status='rejected' WHERE group_id=? AND message_id=? AND status='pending'").run(group, original);
      this.db.prepare("UPDATE confirmations SET status='invalidated' WHERE group_id=? AND original_id=?").run(group, original);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  upcoming(group: string, now: string) {
    return this.db.prepare("SELECT id,data FROM assignments WHERE group_id=? AND deadline>? AND status='active' ORDER BY deadline").all(group, now) as { id: number; data: string }[];
  }
  configureReminders(group: string, settings: ReminderSettings) {
    validateSettings(settings);
    this.db.exec('SAVEPOINT reminder_settings');
    try {
      if (!this.db.prepare('UPDATE groups SET reminder_settings=? WHERE id=?').run(JSON.stringify(settings), group).changes) throw new Error('Unknown group.');
      const saved = this.db.prepare("SELECT * FROM assignments WHERE group_id=? AND status='active'").all(group) as unknown as SavedAssignment[];
      for (const a of saved) {
        const pending = this.db.prepare("SELECT id,offset_hours FROM reminder_jobs WHERE assignment_id=? AND version=? AND kind='reminder' AND offset_hours>0 AND status='pending'").all(a.id, a.version) as { id: number; offset_hours: number }[];
        for (const job of pending) if (!settings.offsetHours.includes(job.offset_hours)) this.db.prepare("UPDATE reminder_jobs SET status='cancelled' WHERE id=?").run(job.id);
        planAssignment(this.db, a.id, a.registered_at ?? new Date().toISOString(), true);
      }
      this.db.exec('RELEASE reminder_settings');
    } catch (error) { this.db.exec('ROLLBACK TO reminder_settings; RELEASE reminder_settings'); throw error; }
  }
  assignment(group: string, id: number) {
    return this.db.prepare("SELECT * FROM assignments WHERE group_id=? AND id=? AND status='active'").get(group, id) as unknown as SavedAssignment | undefined;
  }
  requestChange(group: string, source: string, id: number, action: 'update' | 'cancel', data: Assignment, now: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const existing = this.db.prepare('SELECT * FROM assignment_changes WHERE group_id=? AND source_id=?').get(group, source);
    if (existing) { this.db.exec('COMMIT'); return existing as unknown as { message_id: string; delivered: number; status: string }; }
    const a = this.assignment(group, id);
    if (!a) { this.db.exec('COMMIT'); return undefined; }
    const mid = messageId();
    const change = this.db.prepare('INSERT INTO assignment_changes(group_id,message_id,source_id,assignment_id,version,action,data) VALUES(?,?,?,?,?,?,?)').run(group, mid, source, id, a.version, action, JSON.stringify(data));
    this.db.prepare("INSERT INTO reminder_jobs(assignment_id,version,kind,offset_hours,due_at,next_attempt,message_id,status) VALUES(?,?,'change',?,?,?,?,'pending')").run(id, a.version, Number(change.lastInsertRowid), now, now, mid);
    this.db.exec('COMMIT');
    return { message_id: mid, delivered: 0, status: 'pending' };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  confirmChange(group: string, mid: string, approve: boolean, now: string): 'saved' | 'rejected' | 'stale' | 'busy' | 'invalid' | undefined {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const change = this.db.prepare("SELECT * FROM assignment_changes WHERE group_id=? AND message_id=? AND status='pending' AND delivered=1").get(group, mid) as { assignment_id: number; version: number; action: string; data: string } | undefined;
      if (!change) { this.db.exec('COMMIT'); return undefined; }
      const a = this.assignment(group, change.assignment_id);
      let result: 'saved' | 'rejected' | 'stale' | 'busy' | 'invalid';
      if (!a || a.version !== change.version) result = 'stale';
      else if (!approve) result = 'rejected';
      else if (this.db.prepare("SELECT id FROM reminder_jobs WHERE assignment_id=? AND status='leased'").get(a.id)) result = 'busy';
      else {
        const data = JSON.parse(change.data) as Assignment;
        if (change.action === 'update' && (!data.deadline || data.deadlineIssue || data.deadline <= now)) result = 'invalid';
        else {
          this.db.prepare("UPDATE reminder_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE assignment_id=? AND status IN ('pending','awaiting_approval')").run(a.id);
          this.db.prepare("UPDATE assignment_changes SET status='stale' WHERE group_id=? AND assignment_id=? AND status='pending'").run(group, a.id);
          if (change.action === 'cancel') this.db.prepare("UPDATE assignments SET status='cancelled',version=version+1 WHERE id=?").run(a.id);
          else {
            const registeredAt = data.deadline === a.deadline ? a.registered_at ?? now : now;
            this.db.prepare('UPDATE assignments SET data=?,deadline=?,version=version+1,registered_at=? WHERE id=?').run(change.data, data.deadline!, registeredAt, a.id);
            planAssignment(this.db, a.id, registeredAt, data.deadline === a.deadline);
          }
          result = 'saved';
        }
      }
      if (result !== 'busy' && result !== 'invalid') this.db.prepare('UPDATE assignment_changes SET status=? WHERE group_id=? AND message_id=?').run(result, group, mid);
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  confirmImmediate(group: string, mid: string, approve: boolean, now: string): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prompt = this.db.prepare("SELECT j.assignment_id,j.version FROM reminder_jobs j JOIN assignments a ON a.id=j.assignment_id WHERE a.group_id=? AND a.status='active' AND a.deadline>? AND a.version=j.version AND j.message_id=? AND j.kind='approval' AND j.status='sent'").get(group, now, mid) as { assignment_id: number; version: number } | undefined;
      const changed = prompt ? this.db.prepare("UPDATE reminder_jobs SET status=?,next_attempt=? WHERE assignment_id=? AND version=? AND kind='reminder' AND offset_hours=0 AND status='awaiting_approval'").run(approve ? 'pending' : 'cancelled', now, prompt.assignment_id, prompt.version).changes : 0;
      this.db.exec('COMMIT'); return !!changed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
