import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import { PermanentDeliveryError } from '../src/delivery/engine.js';
import { type Outgoing } from '../src/delivery/outbox.js';
import { Harness, group, otherGroup, leader, admin, admin2, student, otherAdmin, textOf } from './helpers/whatsapp-harness.js';
import { sudaneseAnnouncement, missingDeadlineAnnouncement } from './fixtures/sudanese-announcement.js';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '../src/migrations.js';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let app: Harness;
const rows = () => app.store.db.prepare('SELECT * FROM outgoing_messages ORDER BY id').all() as unknown as (Outgoing & { next_attempt: string; failure_reason: string | null })[];
const preview = () => rows().find(q => q.kind === 'preview')!;
beforeEach(async () => { app = new Harness(); await app.start(); });
afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

describe('persistent outgoing messages through mocked WhatsApp and on-disk SQLite', () => {
  it('persists a three-assignment preview before a disconnected send, then quotes the original after restart', async () => {
    vi.spyOn(app.adapter, 'ready').mockReturnValue(false);
    const original = app.raw(sudaneseAnnouncement); await app.emit(original);
    expect(app.attempts).toHaveLength(0); expect(preview()).toMatchObject({ status: 'pending', attempts: 0 });
    expect(app.store.db.prepare('SELECT drafts FROM confirmations').get()!.drafts).toContain('المصفوفات');
    expect(preview().quote_json).not.toContain('يا شباب');
    await app.send('نعم', admin, group, preview().message_id); expect(app.saved()).toHaveLength(0);
    await app.restart(); await app.worker.flushOutgoing();
    expect(preview().status).toBe('sent');
    const delivered = app.delivered.find(m => m.message.key.id === preview().message_id)!;
    expect(delivered.message.message!.extendedTextMessage!.contextInfo).toMatchObject({ stanzaId: original.key.id, participant: leader });
    expect(textOf(delivered.message)).toContain('3. الرياضيات');
    await app.send('نعم', admin, group, delivered.message.key.id!);
    expect(app.saved()).toHaveLength(3);
  });
  it('survives disconnection during preview delivery without deleting or duplicating its draft', async () => {
    app.disconnectDuringNextSend = true; const original = app.raw(sudaneseAnnouncement); await app.emit(original);
    const id = preview().message_id; expect(preview()).toMatchObject({ status: 'pending', attempts: 1 });
    expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM confirmations').get()!.count).toBe(1);
    app.now = '2027-05-15T00:05:00.000Z'; await app.worker.flushOutgoing(); expect(preview().attempts).toBe(1);
    await app.restart(); await app.worker.flushOutgoing(); await app.emit(original);
    expect(preview()).toMatchObject({ message_id: id, status: 'sent', attempts: 2 });
    expect(rows().filter(q => q.kind === 'preview')).toHaveLength(1);
  });
  it('recovers a crashed sending lease without changing its message ID', async () => {
    vi.spyOn(app.adapter, 'ready').mockReturnValue(false); await app.send(sudaneseAnnouncement);
    const id = preview().message_id;
    app.store.db.prepare("UPDATE outgoing_messages SET status='sending',attempts=1,lease_token='crashed',lease_until=?").run(app.now);
    await app.restart(); await app.worker.flushOutgoing();
    expect(preview()).toMatchObject({ message_id: id, status: 'sent', attempts: 2 });
    expect(app.delivered.filter(m => m.message.key.id === id)).toHaveLength(1);
  });
  it('serializes concurrent queue claims through independent SQLite connections', async () => {
    const ready = vi.spyOn(app.adapter, 'ready').mockReturnValue(false); await app.send(sudaneseAnnouncement); ready.mockRestore();
    const db = new Store(app.path);
    const second = new ReminderWorker(db, app.adapter, id => app.adapter.authorized(id), app.clock, 60000, () => {});
    try {
      await Promise.all([app.worker.flushOutgoing(), second.flushOutgoing(), app.worker.tick(), second.tick()]);
      expect(app.delivered.filter(m => m.message.key.id === preview().message_id)).toHaveLength(1);
      expect(preview()).toMatchObject({ status: 'sent', attempts: 1 });
    } finally { await second.stop(); db.close(); }
  });
  it('retries temporary failures with the same outgoing ID and logs no incoming message or raw exception', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.socket.sendMessage.mockRejectedValueOnce(new Error('SECRET raw failure with student data'));
    await app.send(sudaneseAnnouncement);
    const id = preview().message_id; expect(preview()).toMatchObject({ status: 'pending', next_attempt: '2027-05-15T00:00:01.000Z' });
    app.now = preview().next_attempt; await app.worker.flushOutgoing();
    expect(preview()).toMatchObject({ message_id: id, status: 'sent', attempts: 2 });
    expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET');
    expect(log.mock.calls.flat().join(' ')).not.toContain('الدوال');
  });
  it('exposes a permanent preview failure and requires authorized recovery using its existing ID', async () => {
    app.socket.sendMessage.mockRejectedValueOnce(new PermanentDeliveryError('invalid_message'));
    await app.send(sudaneseAnnouncement); const id = preview().message_id;
    expect(preview()).toMatchObject({ status: 'failed', attempts: 1, failure_reason: 'invalid_message' });
    expect(app.store.db.prepare('SELECT delivery_error FROM confirmations').get()!.delivery_error).toBe('invalid_message');
    await app.send('نعم', admin, group, id); expect(app.saved()).toHaveLength(0);
    await app.send('!delivery', admin);
    expect(textOf(app.last().message)).toContain(id); expect(textOf(app.last().message)).toContain('invalid_message');
    await app.send(`!retry ${id}`, student); expect(preview().status).toBe('failed');
    await app.send(`!retry ${id}`, otherAdmin, otherGroup); expect(preview().status).toBe('failed');
    await app.send(`!retry ${id}`, admin); expect(preview()).toMatchObject({ message_id: id, status: 'sent', attempts: 1 });
    await app.send('نعم', admin, group, id); expect(app.saved()).toHaveLength(3);
  });
  it('caps temporary retries, persists exhaustion across restart, and permits explicit recovery', async () => {
    const send = app.socket.sendMessage.getMockImplementation()!;
    app.socket.sendMessage.mockImplementation(async () => { throw new Error('temporary failure'); });
    await app.send(sudaneseAnnouncement);
    for (let i = 1; i < 8; i++) { app.now = preview().next_attempt; await app.worker.flushOutgoing(); }
    expect(preview()).toMatchObject({ status: 'failed', attempts: 8, failure_reason: 'retry_exhausted' });
    const id = preview().message_id; app.socket.sendMessage.mockImplementation(send);
    await app.restart(); await app.worker.flushOutgoing(); expect(app.delivered).toHaveLength(0);
    expect(preview()).toMatchObject({ message_id: id, status: 'failed', attempts: 8 });
    await app.send(`!retry ${id}`, admin); expect(preview()).toMatchObject({ message_id: id, status: 'sent' });
    expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM confirmations').get()!.count).toBe(1);
  });
  it('atomically queues registration success, then recovers delivery without registering again', async () => {
    await app.send(sudaneseAnnouncement); const originalPreview = app.last();
    const approval = app.raw('نعم', admin, group, originalPreview.message.key.id!);
    app.disconnectDuringNextSend = true; await app.emit(approval);
    expect(app.saved()).toHaveLength(3);
    const success = rows().find(q => q.kind === 'success')!; expect(success.status).toBe('pending');
    await app.restart(); app.now = '2027-05-15T00:00:01.000Z'; await app.worker.flushOutgoing(); await app.emit(approval);
    expect(app.saved()).toHaveLength(3);
    expect(rows().filter(q => q.kind === 'success')).toHaveLength(1);
    const sent = app.delivered.find(m => m.message.key.id === success.message_id)!;
    expect(textOf(sent.message)).toBe('تم تسجيل التكليفات بنجاح.');
    expect(sent.message.message!.extendedTextMessage!.contextInfo).toMatchObject({ stanzaId: approval.key.id, participant: admin });
  });
  it('rolls registration back if SQLite cannot persist its required success response', async () => {
    await app.send(sudaneseAnnouncement); const approval = app.raw('نعم', admin, group, app.last().message.key.id!);
    app.store.db.exec("CREATE TRIGGER fail_success BEFORE INSERT ON outgoing_messages WHEN NEW.kind='success' BEGIN SELECT RAISE(ABORT,'disk error'); END;");
    await app.emit(approval); expect(app.saved()).toHaveLength(0);
    expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM reminder_jobs').get()!.count).toBe(0);
    app.store.db.exec('DROP TRIGGER fail_success'); await app.emit(approval); expect(app.saved()).toHaveLength(3);
    expect(rows().filter(q => q.kind === 'success')).toHaveLength(1);
  });
  it('accepts an exact admin approval during an uncertain preview retry without reactivating the preview', async () => {
    app.loseNextAcknowledgement = true; await app.send(sudaneseAnnouncement); const id = preview().message_id;
    expect(preview().status).toBe('pending'); expect(app.delivered.filter(m => m.message.key.id === id)).toHaveLength(1);
    app.now = preview().next_attempt;
    app.beforeNextDelivery = async () => { await app.send('نعم', admin, group, id); };
    await app.worker.flushOutgoing();
    expect(app.saved()).toHaveLength(3); expect(preview().status).toBe('cancelled');
    expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM confirmations WHERE status='pending'").get()!.count).toBe(0);
    expect(app.delivered.filter(m => m.message.key.id === id)).toHaveLength(1);
    await app.send('نعم', admin2, group, id); expect(app.saved()).toHaveLength(3);
  });
  it('never retries a confirmation after rejection, and preserves rejection feedback during send failure', async () => {
    app.loseNextAcknowledgement = true; await app.send(sudaneseAnnouncement); const id = preview().message_id;
    app.socket.sendMessage.mockRejectedValueOnce(new Error('feedback failed'));
    await app.send('لا', admin, group, id);
    expect(preview().status).toBe('cancelled'); expect(rows().find(q => q.kind === 'feedback')!.status).toBe('pending');
    app.now = '2027-05-15T00:00:01.000Z'; await app.worker.flushOutgoing();
    expect(app.delivered.filter(m => textOf(m.message) === 'تم رفض التسجيل.')).toHaveLength(1);
    expect(app.saved()).toHaveLength(0);
  });
  it('expires old previews and refuses to reactivate them through stale approvals or manual retry', async () => {
    const ready = vi.spyOn(app.adapter, 'ready').mockReturnValue(false); await app.send(sudaneseAnnouncement); ready.mockRestore();
    const id = preview().message_id; app.now = '2027-05-23T00:00:00.000Z'; await app.worker.flushOutgoing();
    expect(preview().status).toBe('expired'); expect(app.delivered).toHaveLength(0);
    expect(app.store.retryDelivery(group, id, app.now)).toBe(false);
    await app.send('نعم', admin, group, id); expect(app.saved()).toHaveLength(0);
  });
  it('invalidates an edited preview before dispatch and suppresses the old queued request', async () => {
    app.loseNextAcknowledgement = true; await app.send(sudaneseAnnouncement); const old = preview().message_id;
    await app.send('!edit 2 deadline=2027-05-24 12:30', admin, group, old);
    const updated = rows().filter(q => q.kind === 'preview').at(-1)!;
    expect(preview().status).toBe('cancelled'); expect(updated.status).toBe('sent');
    app.now = '2027-05-15T00:00:01.000Z'; await app.worker.flushOutgoing();
    expect(app.delivered.filter(m => m.message.key.id === old)).toHaveLength(1);
    await app.send('نعم', admin, group, updated.message_id); expect(app.saved()).toHaveLength(3);
    expect(app.store.assignment(group, 2)!.deadline).toBe('2027-05-24T10:30:00.000Z');
  });
  it('cancels a delayed registration success when every saved assignment has since been cancelled', async () => {
    await app.send(sudaneseAnnouncement); const id = app.last().message.key.id!;
    app.socket.sendMessage.mockRejectedValueOnce(new Error('success failed')); await app.send('نعم', admin, group, id);
    const success = rows().find(q => q.kind === 'success')!;
    for (const assignment of app.store.upcoming(group, app.now)) {
      await app.send(`!delete ${assignment.id}`, admin); await app.worker.tick();
      await app.send('نعم', admin, group, app.last().message.key.id!);
    }
    app.now = '2027-05-15T00:00:01.000Z'; await app.worker.flushOutgoing();
    expect(rows().find(q => q.id === success.id)!.status).toBe('cancelled');
    expect(app.delivered.some(m => m.message.key.id === success.message_id)).toBe(false);
    expect(app.saved()).toHaveLength(0);
  });
  it('keeps pending messages isolated by group and never adds mention metadata to control messages', async () => {
    const ready = vi.spyOn(app.adapter, 'ready').mockReturnValue(false);
    await app.send(sudaneseAnnouncement);
    await app.send('المادة: كيمياء\nعندنا واجب\nتسليم 2027-05-24 18:00\nالتسليم: other@example.edu', '249900000006@s.whatsapp.net', otherGroup);
    ready.mockRestore(); const onlyOne = new ReminderWorker(app.store, app.adapter, id => id === otherGroup, app.clock, 60000, () => {});
    await onlyOne.flushOutgoing(); expect(rows().find(q => q.group_id === group)!.status).toBe('pending');
    expect(app.delivered).toHaveLength(1); expect(app.delivered[0]!.group).toBe(otherGroup);
    const context = app.last().message.message!.extendedTextMessage!.contextInfo!;
    expect(context.nonJidMentions ?? 0).toBe(0); expect(context.mentionedJid ?? []).toHaveLength(0);
    expect(app.socket.groupMetadata).not.toHaveBeenCalled();
  });
  it('does not disable a valid preview when its correction feedback permanently fails', async () => {
    await app.send(missingDeadlineAnnouncement); const id = preview().message_id;
    app.socket.sendMessage.mockRejectedValueOnce(new PermanentDeliveryError('invalid_message'));
    await app.send('نعم', admin, group, id);
    expect(rows().find(q => q.kind === 'feedback')!.status).toBe('failed');
    expect(app.store.confirmation(group, id, app.now)).toBeDefined();
    await app.send('!edit 3 deadline=2027-05-22 20:15', admin, group, id);
    await app.send('نعم', admin, group, app.last().message.key.id!); expect(app.saved()).toHaveLength(3);
  });
  it('recovers delayed success after several days while assignments are still active', async () => {
    await app.send(sudaneseAnnouncement); const id = preview().message_id;
    app.disconnectDuringNextSend = true; await app.send('نعم', admin, group, id);
    const success = rows().find(q => q.kind === 'success')!;
    app.now = '2027-05-18T00:00:00.000Z'; await app.restart(); await app.worker.flushOutgoing();
    expect(app.delivered.filter(m => m.message.key.id === success.message_id)).toHaveLength(1);
    expect(app.saved()).toHaveLength(3);
  });
  it('does not expose arbitrary permanent-error strings or credentials in failure logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.socket.sendMessage.mockRejectedValueOnce(new PermanentDeliveryError('SECRET private key 123'));
    await app.send(sudaneseAnnouncement);
    expect(preview()).toMatchObject({ status: 'failed', failure_reason: 'permanent_failure' });
    expect(log.mock.calls.flat().join(' ')).not.toContain('SECRET');
  });
  it('upgrades a Stage 3 database without losing jobs, stable IDs or existing draft delivery status', () => {
    const path = join(app.folder, 'legacy.sqlite'); const old = new DatabaseSync(path);
    old.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY);');
    for (const migration of migrations.filter(m => m.version < 4)) { old.exec(migration.sql); old.prepare('INSERT INTO migrations VALUES(?)').run(migration.version); }
    old.prepare('INSERT INTO groups(id,leader,admins,timezone) VALUES(?,?,?,?)').run(group, leader, JSON.stringify([admin]), 'Africa/Khartoum');
    old.prepare('INSERT INTO announcements(group_id,message_id) VALUES(?,?)').run(group, 'legacy-original');
    old.prepare('INSERT INTO confirmations(group_id,message_id,original_id,drafts) VALUES(?,?,?,?)').run(group, 'legacy-preview', 'legacy-original', '[]');
    old.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline,registered_at) VALUES(?,?,?,?,?,?)').run(group, 'legacy-original', 1, '{}', '2027-05-20T16:00:00.000Z', app.now);
    old.prepare("INSERT INTO reminder_jobs(assignment_id,version,kind,offset_hours,due_at,next_attempt,message_id,status,attempts) VALUES(1,1,'reminder',24,?,?,?,'pending',3)").run('2027-05-19T16:00:00.000Z', '2027-05-19T16:00:00.000Z', 'LEGACY-STABLE-ID');
    old.close(); const upgraded = new Store(path);
    try {
      expect(upgraded.db.prepare('SELECT message_id,attempts,status,max_attempts FROM reminder_jobs').get()).toMatchObject({ message_id: 'LEGACY-STABLE-ID', attempts: 3, status: 'pending', max_attempts: 8 });
      expect(upgraded.db.prepare('SELECT delivered FROM confirmations').get()!.delivered).toBe(1);
      expect(upgraded.db.prepare('SELECT COUNT(*) AS count FROM outgoing_messages').get()!.count).toBe(0);
    } finally { upgraded.close(); }
  });
  it('rolls a saved change back if its transactional acknowledgement cannot be queued', async () => {
    await app.register(); await app.send('!delete 1', admin); await app.worker.tick();
    const confirmation = app.last().message.key.id!;
    app.store.db.exec("CREATE TRIGGER fail_feedback BEFORE INSERT ON outgoing_messages WHEN NEW.kind='feedback' BEGIN SELECT RAISE(ABORT,'disk error'); END;");
    const approval = app.raw('نعم', admin, group, confirmation); await app.emit(approval);
    expect(app.store.assignment(group, 1)).toBeDefined();
    app.store.db.exec('DROP TRIGGER fail_feedback'); await app.emit(approval);
    expect(app.store.assignment(group, 1)).toBeUndefined();
    expect(textOf(app.last().message)).toBe('تم تأكيد التغيير بنجاح.');
  });
  it('exposes and recovers failed delivery through the local CLI without loading WhatsApp', async () => {
    app.socket.sendMessage.mockRejectedValueOnce(new PermanentDeliveryError('invalid_message')); await app.send(sudaneseAnnouncement);
    const id = preview().message_id;
    const env = { ...process.env, DATABASE_PATH: app.path, WHATSAPP_ENABLE_LIVE: 'true' };
    const report = spawnSync(process.execPath, ['--import', 'tsx', 'src/delivery-cli.ts', 'status', group], { env, encoding: 'utf8', timeout: 20000 });
    expect(report.status).toBe(0); expect(report.stdout).toContain(id); expect(report.stdout).not.toContain('lab@example.edu');
    const retry = spawnSync(process.execPath, ['--import', 'tsx', 'src/delivery-cli.ts', 'retry', group, id], { env, encoding: 'utf8', timeout: 20000 });
    expect(retry.status).toBe(0); expect(preview()).toMatchObject({ status: 'pending', message_id: id });
    await app.worker.flushOutgoing(); expect(preview().status).toBe('sent'); expect(app.saved()).toHaveLength(0);
  }, 25000);
});
