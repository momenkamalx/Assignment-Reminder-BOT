import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Assignment } from './types.js';
import { migrations } from './migrations.js';

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
    this.db.prepare('INSERT INTO groups VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET leader=excluded.leader, admins=excluded.admins, timezone=excluded.timezone').run(id, leader, JSON.stringify(admins), timezone);
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
    this.db.prepare('INSERT INTO confirmations(group_id,message_id,original_id,drafts) VALUES(?,?,?,?)').run(group, id, original, JSON.stringify(drafts));
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
      drafts.forEach((draft, index) => this.db.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline) VALUES(?,?,?,?,?)').run(group, pending.original_id, index + 1, JSON.stringify(draft), draft.deadline!));
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
    return this.db.prepare('SELECT id,data FROM assignments WHERE group_id=? AND deadline>? ORDER BY deadline').all(group, now) as { id: number; data: string }[];
  }
  close() { this.db.close(); }
}
