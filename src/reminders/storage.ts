import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Assignment, ReminderSettings } from '../types.js';

export const messageId = () => randomBytes(16).toString('hex').toUpperCase();
export const utcAfter = (now: string, ms: number) => new Date(Date.parse(now) + ms).toISOString();
export interface SavedAssignment { id: number; group_id: string; data: string; deadline: string; status: string; version: number; registered_at: string | null }
export interface Job { id: number; assignment_id: number; version: number; kind: 'approval' | 'reminder' | 'change'; offset_hours: number; due_at: string; next_attempt: string; message_id: string; status: string; attempts: number; lease_token: string | null; lease_until: string | null }
export function validateSettings(settings: ReminderSettings) {
  if (!Array.isArray(settings.offsetHours) || !settings.offsetHours.includes(24) || settings.offsetHours.some(h => ![24, 72, 2].includes(h)) || !['none', 'individual', 'native_all'].includes(settings.mentions)) throw new Error('Invalid reminder settings.');
}
export function planAssignment(db: DatabaseSync, id: number, registeredAt: string, preserveImmediate = false) {
  const a = db.prepare('SELECT * FROM assignments WHERE id=? AND status=\'active\'').get(id) as unknown as SavedAssignment | undefined;
  if (!a || a.deadline <= registeredAt) return;
  const settings = JSON.parse(db.prepare('SELECT reminder_settings FROM groups WHERE id=?').get(a.group_id)!.reminder_settings as string) as ReminderSettings;
  validateSettings(settings);
  db.prepare('UPDATE assignments SET registered_at=COALESCE(registered_at,?) WHERE id=?').run(registeredAt, id);
  const lateRegistration = Date.parse(a.deadline) - Date.parse(registeredAt) < 86400000;
  const insert = (kind: string, offset: number, due: string, status: string) => {
    db.prepare('INSERT OR IGNORE INTO reminder_jobs(assignment_id,version,kind,offset_hours,due_at,next_attempt,message_id,status) VALUES(?,?,?,?,?,?,?,?)').run(id, a.version, kind, offset, due, due, messageId(), status);
    if (kind === 'reminder' && offset > 0 && status === 'pending') db.prepare("UPDATE reminder_jobs SET status='pending',next_attempt=due_at WHERE assignment_id=? AND version=? AND kind='reminder' AND offset_hours=? AND status='cancelled'").run(id, a.version, offset);
  };
  for (const hours of [...new Set(settings.offsetHours)]) {
    const due = utcAfter(a.deadline, -hours * 3600000);
    if (due < registeredAt || (lateRegistration && due === registeredAt)) continue; // A coincident 2-hour offset must not bypass immediate-reminder consent.
    const sent = db.prepare("SELECT id FROM reminder_jobs WHERE assignment_id=? AND kind='reminder' AND offset_hours=? AND due_at=? AND status='sent'").get(id, hours, due);
    insert('reminder', hours, due, sent ? 'skipped' : 'pending');
  }
  if (lateRegistration) {
    const delivered = preserveImmediate && db.prepare("SELECT id FROM reminder_jobs WHERE assignment_id=? AND kind='reminder' AND offset_hours=0 AND status='sent'").get(id);
    if (!delivered) { insert('reminder', 0, registeredAt, 'awaiting_approval'); insert('approval', 0, registeredAt, 'pending'); }
    else insert('reminder', 0, registeredAt, 'skipped');
  }
}

export function assignmentText(a: Assignment, deadline: string, timezone: string, id: number, formattedDeadline: string) {
  return `تذكير بالتكليف #${id}\nالمادة: ${a.course ?? 'غير مذكورة'}\nالتكليف: ${a.name ?? 'غير مذكور'}\n${a.description ?? ''}\nالموعد: ${formattedDeadline} (${timezone})\nUTC: ${deadline}\nالتسليم: ${a.submissionMethod ?? 'غير مذكور'}\n${a.destination ?? 'وجهة التسليم غير مذكورة'}`;
}
