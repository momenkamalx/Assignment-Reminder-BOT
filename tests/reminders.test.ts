import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/database.js';
import { Bot } from '../src/bot.js';
import { MockWhatsAppAdapter } from '../src/mock-adapter.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import type { Job } from '../src/reminders/storage.js';
import type { WhatsAppAdapter } from '../src/types.js';

let store: Store, adapter: MockWhatsAppAdapter, bot: Bot, worker: ReminderWorker, now: string;
const clock = () => now;
const incoming = (text: string, senderId = 'admin', replyTo?: string, groupId = 'g1') => ({ id: crypto.randomUUID(), groupId, senderId, text, replyTo });
const quiet = () => {};
const jobs = (s = store) => s.db.prepare('SELECT * FROM reminder_jobs ORDER BY id').all() as unknown as Job[];
beforeEach(() => {
  now = '2027-01-01T00:00:00.000Z'; store = new Store(); adapter = new MockWhatsAppAdapter();
  store.configureGroup('g1', 'leader', ['admin', 'admin2']);
  store.configureGroup('g2', 'other-leader', ['other-admin'], 'Asia/Riyadh');
  bot = new Bot(store, adapter, clock); worker = new ReminderWorker(store, adapter, id => ['g1', 'g2'].includes(id), clock, 60000, quiet);
});
afterEach(async () => { await worker.stop(); store.close(); vi.useRealTimers(); });
async function register(deadline = '2027-01-05 12:00Z', destination = 'SUST Moodle https://moodle.sust.example/task', group = 'g1', targetBot = bot, targetStore = store) {
  await targetBot.handle(incoming(`Course: ${group === 'g1' ? 'Math' : 'Physics'}\nassignment\nName: Worksheet\nDue: ${deadline}\nSubmission: ${destination}`, group === 'g1' ? 'leader' : 'other-leader', undefined, group));
  const preview = adapter.sent.at(-1)!;
  await targetBot.handle(incoming('yes', group === 'g1' ? 'admin' : 'other-admin', preview.id, group));
  return targetStore.upcoming(group, clock()).at(-1)!.id;
}
async function request(text: string, group = 'g1') {
  await bot.handle(incoming(text, group === 'g1' ? 'admin' : 'other-admin', undefined, group));
  await worker.tick();
  return adapter.sent.at(-1)!;
}
const reminders = () => adapter.sent.filter(m => m.text.startsWith('تذكير بالتكليف'));

describe('persistent planning, offsets and timezones', () => {
  it('atomically schedules 24 hours before the UTC deadline and sends once at the exact time', async () => {
    await register();
    expect(jobs()).toMatchObject([{ offset_hours: 24, due_at: '2027-01-04T12:00:00.000Z', status: 'pending' }]);
    now = '2027-01-04T11:59:59.999Z'; await worker.tick(); expect(reminders()).toHaveLength(0);
    now = '2027-01-04T12:00:00.000Z'; await worker.tick(); await worker.tick();
    expect(reminders()).toHaveLength(1); expect(jobs()[0]!.status).toBe('sent');
    expect(reminders()[0]!.text).toContain('2027-01-05 14:00:00');
    expect(reminders()[0]!.text).toContain('Africa/Khartoum');
    expect(reminders()[0]!.text).toContain('SUST Moodle');
    expect(reminders()[0]!.text).toContain('https://moodle.sust.example/task');
  });
  it('supports independently enabled 3-day and 2-hour offsets', async () => {
    store.configureReminders('g1', { offsetHours: [72, 24, 2], mentions: 'none' });
    await register();
    for (const instant of ['2027-01-02T12:00:00.000Z', '2027-01-04T12:00:00.000Z', '2027-01-05T10:00:00.000Z']) { now = instant; await worker.tick(); }
    expect(reminders()).toHaveLength(3);
    expect(jobs().every(j => j.status === 'sent')).toBe(true);
  });
  it('does not send an already-passed optional offset when registered over 24 hours in advance', async () => {
    store.configureReminders('g1', { offsetHours: [72, 24, 2], mentions: 'none' });
    await register('2027-01-03 00:00Z');
    expect(jobs().map(j => j.offset_hours).sort((a, b) => a - b)).toEqual([2, 24]);
    await worker.tick(); expect(reminders()).toHaveLength(0);
  });
  it('uses the scheduled reminder rather than a late approval at exactly 24 hours', async () => {
    await register('2027-01-02 00:00Z'); await worker.tick();
    expect(jobs()).toHaveLength(1); expect(jobs()[0]!.kind).toBe('reminder');
    expect(reminders()).toHaveLength(1);
  });
  it('subtracts 24 elapsed hours across daylight saving and displays the correct deadline timezone', async () => {
    now = '2027-03-10T00:00:00.000Z'; store.configureGroup('g1', 'leader', ['admin'], 'America/New_York');
    await register('2027-03-14 12:00');
    expect(jobs()[0]!.due_at).toBe('2027-03-13T16:00:00.000Z');
    now = '2027-03-13T16:00:00.000Z'; await worker.tick();
    expect(reminders()[0]!.text).toContain('2027-03-14 12:00:00 EDT');
    expect(reminders()[0]!.text).toContain('2027-03-14T16:00:00.000Z');
  });
  it('does not schedule an ambiguous, missing or past deadline', async () => {
    for (const deadline of ['بكرة', '', '2020-01-01 12:00Z']) {
      await bot.handle(incoming(`المادة: رياضيات\nعندنا تمرين\nتسليم ${deadline}`, 'leader'));
      await bot.handle(incoming('yes', 'admin', adapter.sent.at(-1)!.id));
    }
    expect(jobs()).toHaveLength(0);
  });
  it('validates offsets and preserves the mandatory 24-hour default', () => {
    expect(() => store.configureReminders('g1', { offsetHours: [2], mentions: 'none' })).toThrow();
    expect(() => store.configureReminders('g1', { offsetHours: [24, 5], mentions: 'none' })).toThrow();
  });
  it('reconciles optional offset changes for existing assignments without recreating sent jobs', async () => {
    await register();
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' });
    const originalId = jobs().find(j => j.offset_hours === 2)!.message_id;
    store.configureReminders('g1', { offsetHours: [24], mentions: 'none' });
    expect(jobs().find(j => j.offset_hours === 2)!.status).toBe('cancelled');
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' });
    expect(jobs().find(j => j.offset_hours === 2)).toMatchObject({ status: 'pending', message_id: originalId });
    now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' }); await worker.tick();
    expect(reminders()).toHaveLength(1);
  });
});

describe('separate admin consent for immediate reminders', () => {
  it('does not bypass immediate consent when an optional 2-hour offset equals registration time', async () => {
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' });
    await register('2027-01-01 02:00Z'); await worker.tick();
    expect(reminders()).toHaveLength(0);
    expect(adapter.sent.at(-1)!.text).toContain('تذكير فوري');
    await bot.handle(incoming('yes', 'admin', adapter.sent.at(-1)!.id)); await worker.tick();
    expect(reminders()).toHaveLength(1);
  });
  it('does not interpret registration approval as consent; requires a new admin reply to the prompt', async () => {
    await register('2027-01-01 12:00Z');
    expect(jobs().find(j => j.kind === 'reminder')!.status).toBe('awaiting_approval');
    await worker.tick(); const prompt = adapter.sent.at(-1)!;
    expect(prompt.text).toContain('هل توافق على إرسال تذكير فوري');
    expect(reminders()).toHaveLength(0);
    await bot.handle(incoming('yes', 'student', prompt.id));
    await bot.handle(incoming('yes', 'admin'));
    await bot.handle(incoming('yes', 'other-admin', prompt.id, 'g2'));
    await worker.tick(); expect(reminders()).toHaveLength(0);
    await bot.handle(incoming('نعم', 'admin', prompt.id));
    await worker.tick();
    await bot.handle(incoming('yes', 'admin2', prompt.id)); await worker.tick();
    expect(reminders()).toHaveLength(1);
  });
  it('declines the immediate reminder but retains a future optional 2-hour reminder', async () => {
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' });
    await register('2027-01-01 12:00Z'); await worker.tick();
    await bot.handle(incoming('لا', 'admin', adapter.sent.at(-1)!.id));
    await worker.tick(); expect(reminders()).toHaveLength(0);
    now = '2027-01-01T10:00:00.000Z'; await worker.tick();
    expect(reminders()).toHaveLength(1);
    expect(jobs().find(j => j.offset_hours === 0 && j.kind === 'reminder')!.status).toBe('cancelled');
  });
  it('expires unanswered immediate requests at the deadline', async () => {
    await register('2027-01-01 12:00Z'); await worker.tick(); const prompt = adapter.sent.at(-1)!;
    now = '2027-01-01T12:00:00.000Z'; await bot.handle(incoming('yes', 'admin', prompt.id)); await worker.tick();
    expect(reminders()).toHaveLength(0);
    expect(jobs().find(j => j.kind === 'reminder')!.status).toBe('expired');
  });
});

describe('downtime, retry and concurrency recovery', () => {
  it('coalesces multiple missed offsets into one most recent reminder before the deadline', async () => {
    store.configureReminders('g1', { offsetHours: [72, 24, 2], mentions: 'none' }); await register();
    now = '2027-01-05T11:00:00.000Z'; await worker.tick();
    expect(reminders()).toHaveLength(1);
    expect(jobs().filter(j => j.status === 'skipped')).toHaveLength(2);
    expect(jobs().find(j => j.status === 'sent')!.offset_hours).toBe(2);
  });
  it('never sends a missed reminder at or after the deadline', async () => {
    await register(); now = '2027-01-05T12:00:00.000Z'; await worker.tick();
    expect(reminders()).toHaveLength(0); expect(jobs()[0]!.status).toBe('expired');
  });
  it('retries after disconnection with persisted backoff and the same message ID', async () => {
    await register(); let connected = false;
    const transport: WhatsAppAdapter = { send: async (...args) => { if (!connected) throw new Error('offline'); return adapter.send(...args); } };
    const retryWorker = new ReminderWorker(store, transport, () => true, clock, 60000, quiet);
    now = '2027-01-04T12:00:00.000Z'; await retryWorker.tick();
    const id = jobs()[0]!.message_id;
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 1, next_attempt: '2027-01-04T12:00:01.000Z' });
    connected = true; await retryWorker.tick(); expect(reminders()).toHaveLength(0);
    now = '2027-01-04T12:00:01.000Z'; await retryWorker.tick();
    expect(reminders()).toHaveLength(1); expect(reminders()[0]!.id).toBe(id);
  });
  it('avoids a second mock delivery if the first send succeeded but its acknowledgement was lost', async () => {
    await register(); let fail = true;
    const transport: WhatsAppAdapter = { send: async (...args) => { const id = await adapter.send(...args); if (fail) { fail = false; throw new Error('ack lost'); } return id; } };
    const retryWorker = new ReminderWorker(store, transport, () => true, clock, 60000, quiet);
    now = '2027-01-04T12:00:00.000Z'; await retryWorker.tick();
    now = '2027-01-04T12:00:01.000Z'; await retryWorker.tick();
    expect(reminders()).toHaveLength(1); expect(jobs()[0]!.status).toBe('sent');
  });
  it('recovers an expired claim left by a crashed worker using its persistent message ID', async () => {
    await register(); const id = jobs()[0]!.message_id;
    store.db.prepare("UPDATE reminder_jobs SET status='leased',lease_token='old',lease_until=?").run('2027-01-04T11:59:00.000Z');
    now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    expect(reminders()[0]!.id).toBe(id); expect(jobs()[0]!.status).toBe('sent');
  });
  it('persists jobs across database restarts and protects simultaneous claims through separate connections', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'reminder-concurrency-')); const path = join(folder, 'bot.sqlite');
    let first: Store | undefined, second: Store | undefined;
    try {
      first = new Store(path); first.configureGroup('g1', 'leader', ['admin']);
      const initialBot = new Bot(first, adapter, clock); await register(undefined, undefined, 'g1', initialBot, first);
      first.close(); first = new Store(path); second = new Store(path);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const slow: WhatsAppAdapter = { send: async (...args) => { await gate; return adapter.send(...args); } };
      const a = new ReminderWorker(first, slow, id => id === 'g1', clock, 60000, quiet);
      const b = new ReminderWorker(second, adapter, id => id === 'g1', clock, 60000, quiet);
      now = '2027-01-04T12:00:00.000Z'; const sending = a.tick();
      await Promise.all([b.tick(), b.tick(), b.tick()]);
      expect(reminders()).toHaveLength(0); release(); await sending;
      await Promise.all([a.tick(), b.tick()]); expect(reminders()).toHaveLength(1);
      expect(jobs(second)[0]!.status).toBe('sent');
    } finally { first?.close(); second?.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it('recovers a late-assignment approval after restarting both the database and bot', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'reminder-approval-restart-')); const path = join(folder, 'bot.sqlite');
    let persistent: Store | undefined;
    try {
      persistent = new Store(path); persistent.configureGroup('g1', 'leader', ['admin']);
      let restartedBot = new Bot(persistent, adapter, clock);
      await register('2027-01-01 12:00Z', undefined, 'g1', restartedBot, persistent);
      let restartedWorker = new ReminderWorker(persistent, adapter, id => id === 'g1', clock, 60000, quiet);
      await restartedWorker.tick(); const prompt = adapter.sent.at(-1)!;
      persistent.close(); persistent = undefined;
      persistent = new Store(path); restartedBot = new Bot(persistent, adapter, clock);
      restartedWorker = new ReminderWorker(persistent, adapter, id => id === 'g1', clock, 60000, quiet);
      await restartedBot.handle(incoming('yes', 'admin', prompt.id)); await restartedWorker.tick();
      expect(reminders()).toHaveLength(1); await restartedWorker.tick(); expect(reminders()).toHaveLength(1);
    } finally { persistent?.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it('sends each of several simultaneously due assignments once across competing workers', async () => {
    await register('2027-01-05 12:00Z', 'teacher@example.edu', 'g1');
    await register('2027-01-05 12:00Z', 'https://submit.example.edu/physics', 'g2');
    now = '2027-01-04T12:00:00.000Z';
    const otherWorker = new ReminderWorker(store, adapter, id => ['g1', 'g2'].includes(id), clock, 60000, quiet);
    await Promise.all([worker.tick(), otherWorker.tick(), worker.tick(), otherWorker.tick()]);
    expect(reminders()).toHaveLength(2);
    expect(reminders().map(m => m.groupId).sort()).toEqual(['g1', 'g2']);
    expect(new Set(reminders().map(m => m.id)).size).toBe(2);
  });
  it('renews its lease during a slow send so another worker cannot claim it', async () => {
    await register(); vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-04T12:00:00.000Z'));
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: WhatsAppAdapter = { send: async (...args) => { await gate; return adapter.send(...args); } };
    const a = new ReminderWorker(store, slow, () => true, () => new Date().toISOString(), 90, quiet);
    const b = new ReminderWorker(store, adapter, () => true, () => new Date().toISOString(), 90, quiet);
    const sending = a.tick();
    try { await vi.advanceTimersByTimeAsync(300); await b.tick(); expect(reminders()).toHaveLength(0); }
    finally { release(); await sending; }
    expect(reminders()).toHaveLength(1);
  });
  it('recovers an already-sent job when persisting the sent state fails', async () => {
    await register();
    store.db.exec("CREATE TRIGGER fail_sent BEFORE UPDATE OF status ON reminder_jobs WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'disk error'); END;");
    now = '2027-01-04T12:00:00.000Z'; await worker.tick(); expect(reminders()).toHaveLength(1);
    expect(jobs()[0]!.status).toBe('pending'); store.db.exec('DROP TRIGGER fail_sent');
    now = '2027-01-04T12:00:01.000Z'; await worker.tick();
    expect(reminders()).toHaveLength(1); expect(jobs()[0]!.status).toBe('sent');
  });
  it('safely runs a periodic scheduler and stops its timer', async () => {
    await register(); vi.useFakeTimers(); now = '2027-01-04T12:00:00.000Z';
    worker.start(100); await worker.tick(); await vi.advanceTimersByTimeAsync(300); await worker.stop();
    expect(reminders()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('confirmed deadline changes and cancellations', () => {
  it('updates only after confirmation, invalidates old jobs and schedules the new deadline', async () => {
    store.configureReminders('g1', { offsetHours: [24, 2], mentions: 'none' }); const id = await register();
    const prompt = await request(`!edit ${id} deadline=2027-01-08 12:00Z`);
    expect(prompt.text).toContain('هل تؤكد تعديل');
    expect(store.assignment('g1', id)!.deadline).toBe('2027-01-05T12:00:00.000Z');
    await bot.handle(incoming('yes', 'student', prompt.id)); expect(store.assignment('g1', id)!.version).toBe(1);
    await bot.handle(incoming('نعم', 'admin', prompt.id));
    expect(store.assignment('g1', id)).toMatchObject({ version: 2, deadline: '2027-01-08T12:00:00.000Z' });
    expect(jobs().filter(j => j.version === 1 && j.kind === 'reminder').every(j => j.status === 'cancelled')).toBe(true);
    now = '2027-01-04T12:00:00.000Z'; await worker.tick(); expect(reminders()).toHaveLength(0);
    now = '2027-01-07T12:00:00.000Z'; await worker.tick(); expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.text).toContain('2027-01-08T12:00:00.000Z');
  });
  it('requires separate immediate-reminder consent when a confirmed update moves the deadline within 24 hours', async () => {
    const id = await register(); const prompt = await request(`!edit ${id} deadline=2027-01-01 12:00Z`);
    await bot.handle(incoming('yes', 'admin', prompt.id)); await worker.tick();
    const approval = adapter.sent.at(-1)!; expect(approval.text).toContain('تذكير فوري'); expect(reminders()).toHaveLength(0);
    await bot.handle(incoming('yes', 'admin', approval.id)); await worker.tick(); expect(reminders()).toHaveLength(1);
  });
  it('cancels only after confirmation and never delivers its queued reminders', async () => {
    const id = await register(); const prompt = await request(`!delete ${id}`);
    expect(store.upcoming('g1', now)).toHaveLength(1);
    await Promise.all([bot.handle(incoming('yes', 'admin', prompt.id)), bot.handle(incoming('yes', 'admin2', prompt.id))]);
    expect(store.upcoming('g1', now)).toHaveLength(0);
    now = '2027-01-04T12:00:00.000Z'; await worker.tick(); expect(reminders()).toHaveLength(0);
    expect(adapter.sent.filter(m => m.text === 'تم تأكيد التغيير بنجاح.')).toHaveLength(1);
  });
  it('rejects cancellation without changing the schedule', async () => {
    const id = await register(); const prompt = await request(`!delete ${id}`);
    await bot.handle(incoming('no', 'admin', prompt.id));
    expect(store.assignment('g1', id)!.status).toBe('active');
    now = '2027-01-04T12:00:00.000Z'; await worker.tick(); expect(reminders()).toHaveLength(1);
  });
  it('invalidates stale update confirmations when another change wins', async () => {
    const id = await register(); const first = await request(`!edit ${id} deadline=2027-01-08 12:00Z`);
    const second = await request(`!edit ${id} deadline=2027-01-09 12:00Z`);
    await bot.handle(incoming('yes', 'admin', first.id)); await bot.handle(incoming('yes', 'admin2', second.id));
    expect(store.assignment('g1', id)!.deadline).toBe('2027-01-08T12:00:00.000Z');
  });
  it('rejects invalid deadlines and forbids cross-group or non-admin mutation requests', async () => {
    const id = await register(); const baseline = jobs().length;
    await bot.handle(incoming(`!edit ${id} deadline=بكرة`));
    await bot.handle(incoming(`!delete ${id}`, 'student'));
    await bot.handle(incoming(`!delete ${id}`, 'other-admin', undefined, 'g2'));
    expect(jobs()).toHaveLength(baseline); expect(store.assignment('g1', id)!.version).toBe(1);
  });
  it('keeps a cancellation pending if a reminder is already being sent, then accepts a later confirmation', async () => {
    const id = await register(); const prompt = await request(`!delete ${id}`);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: WhatsAppAdapter = { send: async (...args) => { await gate; return adapter.send(...args); } };
    const sendingWorker = new ReminderWorker(store, slow, () => true, clock, 60000, quiet);
    now = '2027-01-04T12:00:00.000Z'; const sending = sendingWorker.tick();
    try {
      await bot.handle(incoming('yes', 'admin', prompt.id));
      expect(store.assignment('g1', id)!.status).toBe('active');
      expect(adapter.sent.at(-1)!.text).toContain('قيد الإرسال');
    } finally { release(); await sending; }
    await bot.handle(incoming('yes', 'admin', prompt.id)); expect(store.assignment('g1', id)).toBeUndefined();
  });
  it('does not replay a delivered offset when only assignment metadata changes', async () => {
    const id = await register(); now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    const prompt = await request(`!edit ${id} name=Updated worksheet`);
    await bot.handle(incoming('yes', 'admin', prompt.id)); await worker.tick();
    expect(reminders()).toHaveLength(1);
    expect(jobs().find(j => j.version === 2 && j.kind === 'reminder')!.status).toBe('skipped');
  });
  it('recovers an undelivered mutation prompt after disconnection and prevents duplicate command registration', async () => {
    const id = await register(); const command = incoming(`!delete ${id}`);
    await bot.handle(command); await bot.handle(command);
    expect(jobs().filter(j => j.kind === 'change')).toHaveLength(1);
    const offline = new ReminderWorker(store, { send: async () => { throw new Error('offline'); } }, () => true, clock, 60000, quiet);
    await offline.tick(); now = '2027-01-01T00:00:01.000Z'; await worker.tick();
    const prompt = adapter.sent.at(-1)!; expect(prompt.text).toContain('هل تؤكد إلغاء');
    await bot.handle(incoming('yes', 'admin', prompt.id)); expect(store.assignment('g1', id)).toBeUndefined();
  });
});

describe('group isolation and configurable mentions', () => {
  it('routes different deadlines and submission destinations to their correct groups only', async () => {
    await register('2027-01-05 12:00Z', 'teacher@example.edu', 'g1');
    await register('2027-01-06 18:00', 'https://submit.example.edu/physics', 'g2');
    now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    expect(reminders()).toHaveLength(1); expect(reminders()[0]).toMatchObject({ groupId: 'g1' });
    expect(reminders()[0]!.text).toContain('teacher@example.edu');
    now = '2027-01-05T15:00:00.000Z'; await worker.tick();
    expect(reminders()[1]).toMatchObject({ groupId: 'g2' });
    expect(reminders()[1]!.text).toContain('https://submit.example.edu/physics');
    expect(reminders()[1]!.text).toContain('2027-01-06 18:00:00');
    expect(reminders()[1]!.text).not.toContain('teacher@example.edu');
  });
  it('does not deliver to groups removed from the runtime allowlist', async () => {
    await register(); now = '2027-01-04T12:00:00.000Z';
    const denied = new ReminderWorker(store, adapter, () => false, clock, 60000, quiet); await denied.tick();
    expect(reminders()).toHaveLength(0); expect(jobs()[0]!.status).toBe('pending');
  });
  it('disables mentions and member lookup by default', async () => {
    const members = vi.spyOn(adapter, 'members'); await register(); now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    expect(members).not.toHaveBeenCalled(); expect(reminders()[0]!.options).toEqual({ messageId: jobs()[0]!.message_id });
    expect(reminders()[0]!.text).not.toContain('@all');
  });
  it('uses explicit participant JIDs only from the targeted group for opt-in individual mentions', async () => {
    store.configureReminders('g1', { offsetHours: [24], mentions: 'individual' });
    adapter.groupMembers.set('g1', ['249111@s.whatsapp.net', '249222@s.whatsapp.net', '249111@s.whatsapp.net']);
    adapter.groupMembers.set('g2', ['249999@s.whatsapp.net']);
    await register(); now = '2027-01-04T12:00:00.000Z'; await worker.tick();
    expect(reminders()[0]!.options!.mentions).toEqual(['249111@s.whatsapp.net', '249222@s.whatsapp.net']);
    expect(reminders()[0]!.text).toContain('@249111'); expect(reminders()[0]!.text).not.toContain('@249999');
  });
  it('uses native mention metadata only when enabled, and never tags an approval prompt', async () => {
    store.configureReminders('g1', { offsetHours: [24], mentions: 'native_all' });
    await register('2027-01-01 12:00Z'); await worker.tick(); const prompt = adapter.sent.at(-1)!;
    expect(prompt.options!.mentionAll).toBeUndefined(); await bot.handle(incoming('yes', 'admin', prompt.id)); await worker.tick();
    expect(reminders()[0]!.options!.mentionAll).toBe(true);
  });
  it('rechecks deadline validity after an asynchronous member lookup before sending', async () => {
    store.configureReminders('g1', { offsetHours: [24], mentions: 'individual' }); await register();
    now = '2027-01-04T12:00:00.000Z';
    vi.spyOn(adapter, 'members').mockImplementation(async () => { now = '2027-01-05T12:00:00.000Z'; return ['249111@s.whatsapp.net']; });
    await worker.tick(); expect(reminders()).toHaveLength(0); expect(jobs()[0]!.status).toBe('expired');
  });
});
