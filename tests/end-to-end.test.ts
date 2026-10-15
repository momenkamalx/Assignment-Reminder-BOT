import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { DisconnectReason, generateWAMessage, initAuthCreds, type WAMessage, type AnyMessageContent, type MiscMessageGenerationOptions, type AuthenticationState } from '@whiskeysockets/baileys';
import { Store } from '../src/database.js';
import { BaileysAdapter, type Socket } from '../src/whatsapp/adapter.js';
import { WhatsAppRuntime } from '../src/whatsapp/runtime.js';
import { applyGroups, parseGroups, type GroupConfig } from '../src/whatsapp/config.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import type { Assignment } from '../src/types.js';
import { expectedAssignments, missingDeadlineAnnouncement, sudaneseAnnouncement } from './fixtures/sudanese-announcement.js';

import { group, otherGroup, leader, admin, admin2, student, self, otherLeader, otherAdmin, textOf, FakeSocket, Harness } from './helpers/whatsapp-harness.js';

let app: Harness;
beforeEach(async () => { app = new Harness(); await app.start(); });
afterEach(async () => { await app.close(); });

describe('Stages 1–3 through mocked Baileys events and temporary SQLite', () => {
  it('extracts three realistic announcements, corrects a draft, quotes the original and registers only on exact admin approval', async () => {
    await app.send(sudaneseAnnouncement, student); expect(app.delivered).toHaveLength(0);
    const original = app.raw(sudaneseAnnouncement); await app.emit(original);
    const preview = app.last();
    for (const [i, a] of expectedAssignments.entries()) expect(textOf(preview.message)).toContain(`${i + 1}. ${a.course} — ${a.name}`);
    expect(preview.message.message!.extendedTextMessage!.contextInfo).toMatchObject({ stanzaId: original.key.id, participant: leader });
    await app.send('نعم', student, group, preview.message.key.id!);
    await app.send('نعم', admin);
    await app.send('نعم', admin, group, 'unrelated');
    await app.send('نعم', admin, group, preview.message.key.id!, student);
    expect(app.saved()).toHaveLength(0);
    await app.send('!edit 2 deadline=2027-05-23 12:30', admin, group, preview.message.key.id!);
    const corrected = app.last();
    expect(corrected.message.message!.extendedTextMessage!.contextInfo!.stanzaId).toBe(original.key.id);
    await app.send('نعم', admin, group, preview.message.key.id!); expect(app.saved()).toHaveLength(0);
    await app.send('نعم', admin, group, corrected.message.key.id!);
    const expected = expectedAssignments.map(a => ({ ...a })); expected[1]!.deadline = '2027-05-23T10:30:00.000Z';
    expect(app.saved()).toEqual([expected[0], expected[2], expected[1]]);
    expect(textOf(app.last().message)).toBe('تم تسجيل التكليفات بنجاح.');
    expect(app.store.db.prepare('SELECT DISTINCT original_id FROM assignments').all()).toEqual([{ original_id: original.key.id }]);
    for (const date of ['2027-05-19T16:00:00.000Z', '2027-05-21T18:15:00.000Z', '2027-05-22T10:30:00.000Z']) { app.now = date; await app.worker.tick(); }
    expect(app.reminders()).toHaveLength(3);
    for (const a of expected) {
      const reminder = app.reminders().find(m => textOf(m.message).includes(`التكليف: ${a.name}`))!;
      expect(reminder.group).toBe(group);
      for (const value of [a.course!, a.name!, a.deadline!, a.submissionMethod!, a.destination!, 'Africa/Khartoum']) expect(textOf(reminder.message)).toContain(value);
      expect(reminder.message.message!.extendedTextMessage?.contextInfo?.nonJidMentions ?? 0).toBe(0);
      expect(reminder.message.message!.extendedTextMessage?.contextInfo?.mentionedJid ?? []).toHaveLength(0);
    }
    expect(app.socket.groupMetadata).not.toHaveBeenCalled();
  });
  it('recovers a pending draft after restart and quotes its persisted original key during correction', async () => {
    const original = app.raw(sudaneseAnnouncement); await app.emit(original); const preview = app.last();
    await app.restart(); await app.send('!edit 1 deadline=2027-05-24 18:00', admin, group, preview.message.key.id!);
    const corrected = app.last();
    expect(corrected.message.message!.extendedTextMessage!.contextInfo).toMatchObject({ stanzaId: original.key.id, participant: leader });
    await app.send('نعم', admin, group, corrected.message.key.id!);
    expect(app.saved()).toHaveLength(3);
    expect(app.store.assignment(group, 1)!.deadline).toBe('2027-05-24T16:00:00.000Z');
    expect(app.store.confirmation(group, preview.message.key.id!)).toBeUndefined();
  });
  it('invalidates the old preview transactionally before dispatching an edit, so a concurrent old approval cannot win', async () => {
    const original = app.raw(sudaneseAnnouncement); await app.emit(original); const preview = app.last();
    const secondStore = new Store(app.path);
    const adapter = new BaileysAdapter(secondStore, app.configs, app.clock); adapter.attach(new FakeSocket(app).asSocket(), true);
    try {
      app.beforeNextDelivery = async () => {
        await adapter.receive({ type: 'notify', messages: [app.raw('نعم', admin2, group, preview.message.key.id!)] });
      };
      await app.send('!edit 1 deadline=2027-05-24 18:00', admin, group, preview.message.key.id!);
      expect(app.saved()).toHaveLength(0);
      expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM confirmations WHERE status='pending'").get()!.count).toBe(1);
      await app.send('نعم', admin, group, app.last().message.key.id!);
      expect(app.saved()).toHaveLength(3);
      expect(app.store.assignment(group, 1)!.deadline).toBe('2027-05-24T16:00:00.000Z');
      expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM confirmations WHERE status='pending'").get()!.count).toBe(0);
    } finally { secondStore.close(); }
  });
  it('allows one registration through competing runtime/SQLite connections and invalidates all sibling confirmations', async () => {
    const original = app.raw(sudaneseAnnouncement); await app.emit(original); const preview = app.last();
    const drafts = JSON.parse(app.store.confirmation(group, preview.message.key.id!)!.drafts);
    const siblingId = await app.adapter.send(group, textOf(preview.message), original.key.id!);
    app.store.addConfirmation(group, siblingId, original.key.id!, drafts);
    const secondStore = new Store(app.path); const adapter = new BaileysAdapter(secondStore, app.configs, app.clock);
    const socket = new FakeSocket(app);
    const runtime = new WhatsAppRuntime(adapter, {
      loadAuth: async () => ({ state: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } }, saveCreds: async () => {} }),
      createSocket: () => socket.asSocket(), qr: () => {}, log: () => {},
    });
    try {
      await runtime.start(); socket.ev.emit('connection.update', { connection: 'open' });
      await Promise.all([app.emit(app.raw('نعم', admin, group, preview.message.key.id!)), app.emit(app.raw('نعم', admin2, group, siblingId), runtime, socket)]);
      expect(app.saved()).toEqual(expectedAssignments);
      expect(app.delivered.filter(m => textOf(m.message) === 'تم تسجيل التكليفات بنجاح.')).toHaveLength(1);
      expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM confirmations WHERE status='pending'").get()!.count).toBe(0);
      await app.emit(original); await app.send('نعم', admin, group, preview.message.key.id!);
      expect(app.saved()).toHaveLength(3);
      expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM reminder_jobs').get()!.count).toBe(3);
    } finally { runtime.stop(); await runtime.idle(); secondStore.close(); }
  });
  it('delivers all configured offsets without duplicates across competing workers', async () => {
    app.store.configureReminders(group, { offsetHours: [72, 24, 2], mentions: 'none' }); await app.register();
    const otherStore = new Store(app.path);
    const worker = new ReminderWorker(otherStore, app.adapter, id => app.adapter.authorized(id), app.clock, 60000, () => {});
    try {
      const dates = app.store.db.prepare('SELECT DISTINCT due_at FROM reminder_jobs ORDER BY due_at').all() as { due_at: string }[];
      expect(dates).toHaveLength(9);
      for (const date of dates) { app.now = date.due_at; await Promise.all([app.worker.tick(), worker.tick(), app.worker.tick()]); }
      expect(app.reminders()).toHaveLength(9);
      expect(new Set(app.reminders().map(m => m.message.key.id)).size).toBe(9);
      expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM reminder_jobs WHERE status='sent'").get()!.count).toBe(9);
    } finally { await worker.stop(); otherStore.close(); }
  });
  it('turns a non-admin leader extension into an approval request, replaces its schedule and honours a cancellation', async () => {
    await app.register();
    const extension = app.raw('يا شباب تم تمديد تسليم التكليف #١ لحدي ٢٠٢٧-٠٥-٢٤ ١٨:٠٠'); await app.emit(extension);
    expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM assignment_changes WHERE status='pending'").get()!.count).toBe(1);
    expect(app.store.assignment(group, 1)!.deadline).toBe(expectedAssignments[0]!.deadline);
    await app.worker.tick(); const change = app.last(); expect(textOf(change.message)).toContain('هل تؤكد تعديل');
    await app.send('نعم', leader, group, change.message.key.id!); expect(app.store.assignment(group, 1)!.version).toBe(1);
    await app.send('نعم', admin, group, change.message.key.id!);
    expect(app.store.assignment(group, 1)).toMatchObject({ version: 2, deadline: '2027-05-24T16:00:00.000Z' });
    expect(app.store.db.prepare("SELECT status FROM reminder_jobs WHERE assignment_id=1 AND version=1 AND kind='reminder'").get()!.status).toBe('cancelled');
    await app.emit(extension); expect(app.store.upcoming(group, app.now)).toHaveLength(3);
    await app.send('!delete 2', admin); await app.worker.tick(); const cancel = app.last();
    await app.send('نعم', admin, group, cancel.message.key.id!);
    app.now = '2027-05-19T16:00:00.000Z'; await app.worker.tick(); expect(app.reminders()).toHaveLength(0);
    app.now = '2027-05-20T10:30:00.000Z'; await app.worker.tick(); expect(app.reminders()).toHaveLength(0);
    app.now = '2027-05-21T18:15:00.000Z'; await app.worker.tick(); expect(app.reminders()).toHaveLength(1);
    app.now = '2027-05-23T16:00:00.000Z'; await app.worker.tick();
    expect(app.reminders()).toHaveLength(2);
    expect(app.reminders().some(m => textOf(m.message).includes('تقرير المعمل'))).toBe(false);
    expect(app.reminders().find(m => textOf(m.message).includes('الدوال'))!.message.message!.extendedTextMessage!.text).toContain('2027-05-24T16:00:00.000Z');
  });
  it('persists a reminder interrupted during delivery, restarts and retries its original outgoing ID in the correct group', async () => {
    await app.register();
    await app.register('المادة: الكيمياء\nعندنا واجب\nاسم التكليف: التجربة\nتسليم 2027-05-21 18:00\nالتسليم: other@example.edu', otherGroup);
    app.now = '2027-05-19T16:00:00.000Z'; app.disconnectDuringNextSend = true; await app.worker.tick();
    const pending = app.store.db.prepare("SELECT message_id,status,next_attempt FROM reminder_jobs WHERE assignment_id=1").get()!;
    expect(pending).toMatchObject({ status: 'pending', next_attempt: '2027-05-19T16:00:01.000Z' }); expect(app.reminders()).toHaveLength(0);
    await app.restart(); expect(app.saved()).toHaveLength(3); expect(app.saved(otherGroup)).toHaveLength(1);
    app.now = '2027-05-19T16:00:01.000Z'; await app.worker.tick(); await app.worker.tick();
    expect(app.reminders()).toHaveLength(1); expect(app.reminders()[0]!.message.key.id).toBe(pending.message_id);
    expect(app.reminders()[0]!.group).toBe(group);
    expect(app.attempts.filter(m => m.message.key.id === pending.message_id)).toHaveLength(2);
    app.now = '2027-05-20T16:00:00.000Z'; await app.worker.tick();
    const other = app.reminders().find(m => m.group === otherGroup)!;
    expect(textOf(other.message)).toContain('other@example.edu'); expect(textOf(other.message)).not.toContain('lab@example.edu');
  });
  it('coalesces reminders missed during downtime and expires anything after its deadline', async () => {
    app.configs[0]!.reminders = { offsetHours: [72, 24, 2], mentions: 'none' };
    app.store.configureReminders(group, app.configs[0]!.reminders); await app.register();
    await app.restart(); app.now = '2027-05-20T15:00:00.000Z'; await app.worker.tick();
    expect(app.reminders().filter(m => textOf(m.message).includes('الدوال'))).toHaveLength(1);
    expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM reminder_jobs WHERE assignment_id=1 AND status='skipped'").get()!.count).toBe(2);
    app.now = '2027-05-23T00:00:00.000Z'; const count = app.reminders().length; await app.worker.tick();
    expect(app.reminders()).toHaveLength(count);
    expect(app.store.db.prepare("SELECT COUNT(*) AS count FROM reminder_jobs WHERE status='expired'").get()!.count).toBeGreaterThan(0);
  });
  it('does not invent extension targets or deadlines, and ignores extension requests from students', async () => {
    await app.register();
    await app.send('يا شباب تم تمديد تسليم التكليف #1 لحدي 2027-05-24 18:00', student);
    await app.send('يا شباب تم تمديد التسليم لحدي 2027-05-24 18:00');
    await app.send('يا شباب تم تمديد تسليم التكليف #1 والتكليف #2 لحدي 2027-05-24 18:00');
    await app.send('يا شباب تم تمديد تسليم التكليف #1 لبكرة');
    await app.send('يا شباب تم تمديد تسليم التكليف #1 لحدي 2027-05-19 18:00');
    expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM assignment_changes').get()!.count).toBe(0);
    expect(app.saved()).toEqual(expectedAssignments);
    expect(app.store.db.prepare('SELECT COUNT(*) AS count FROM announcements').get()!.count).toBe(1);
  });
  it('retains missing deadlines until correction and keeps late-reminder approval separate across a restart', async () => {
    app.now = '2027-05-20T08:00:00.000Z'; const original = app.raw(missingDeadlineAnnouncement); await app.emit(original);
    await app.send('نعم', admin, group, app.last().message.key.id!); expect(app.saved()).toHaveLength(0);
    await app.send('!edit 3 deadline=2027-05-22 20:15', admin, group, app.delivered[0]!.message.key.id!);
    const corrected = app.last(); await app.send('نعم', admin, group, corrected.message.key.id!); await app.worker.tick();
    const late = app.delivered.find(m => textOf(m.message).startsWith('تم التسجيل قبل الموعد'))!;
    expect(late).toBeDefined(); expect(app.reminders().some(m => textOf(m.message).includes('الدوال'))).toBe(false);
    await app.restart(); await app.send('نعم', student, group, late.message.key.id!); await app.worker.tick();
    expect(app.reminders().some(m => textOf(m.message).includes('الدوال'))).toBe(false);
    await app.send('نعم', admin, group, late.message.key.id!); await app.worker.tick();
    expect(app.reminders().filter(m => textOf(m.message).includes('الدوال'))).toHaveLength(1);
    await app.send('نعم', admin2, group, late.message.key.id!); await app.worker.tick();
    expect(app.reminders().filter(m => textOf(m.message).includes('الدوال'))).toHaveLength(1);
  });
  it('rejects private/unlisted groups, forged quote authors, wrong-group permissions and display-name impersonation', async () => {
    for (const chat of [leader, '120363999999999999@g.us', 'status@broadcast']) await app.send(sudaneseAnnouncement, leader, chat);
    const impersonator = app.raw(sudaneseAnnouncement, student); impersonator.pushName = 'قائد الدفعة'; await app.emit(impersonator);
    expect(app.delivered).toHaveLength(0);
    const original = app.raw(sudaneseAnnouncement); await app.emit(original); const preview = app.last();
    await app.send('نعم', otherAdmin, group, preview.message.key.id!);
    await app.send('نعم', admin, otherGroup, preview.message.key.id!);
    await app.send('نعم', admin, group, preview.message.key.id!, leader);
    expect(app.saved()).toHaveLength(0);
    await app.send('نعم', admin, group, preview.message.key.id!); expect(app.saved()).toHaveLength(3);
    await expect(app.adapter.send(leader, 'blocked')).rejects.toThrow('allowlist');
  });
  it.each(['native_all', 'individual'] as const)('serializes opt-in %s reminder metadata through the real SDK without a connection', async mode => {
    app.store.configureReminders(group, { offsetHours: [24], mentions: mode }); await app.register();
    app.now = '2027-05-19T16:00:00.000Z'; await app.worker.tick();
    const reminder = app.reminders()[0]!; const context = reminder.message.message!.extendedTextMessage!.contextInfo!;
    if (mode === 'native_all') { expect(context.nonJidMentions).toBe(1); expect(app.socket.groupMetadata).not.toHaveBeenCalled(); }
    else {
      expect(context.mentionedJid).toEqual([leader, admin, student]);
      expect(context.mentionedJid).not.toContain(otherAdmin);
      expect(app.socket.groupMetadata).toHaveBeenCalledWith(group);
    }
    expect(app.delivered.find(m => textOf(m.message).includes('هل تريد تسجيل التكليفات'))!.message.message!.extendedTextMessage!.contextInfo!.nonJidMentions ?? 0).toBe(0);
  });
});
