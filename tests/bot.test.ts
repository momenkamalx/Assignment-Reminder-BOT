import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot.js';
import { Store } from '../src/database.js';
import { MockWhatsAppAdapter } from '../src/mock-adapter.js';
import type { IncomingMessage } from '../src/types.js';
import { ReminderWorker } from '../src/reminders/worker.js';
import { expectedAssignments, missingDeadlineAnnouncement, sudaneseAnnouncement } from './fixtures/sudanese-announcement.js';

let store: Store, adapter: MockWhatsAppAdapter, bot: Bot;
const now = () => '2027-01-01T00:00:00.000Z';
const announcement = 'Course: Math\nAssignment\nName: Worksheet\nDue 2027-05-20 18:00';
const message = (text: string, senderId = 'leader', replyTo?: string, groupId = 'g1'): IncomingMessage => ({ id: crypto.randomUUID(), text, senderId, groupId, replyTo });
beforeEach(() => {
  store = new Store(); adapter = new MockWhatsAppAdapter(); bot = new Bot(store, adapter, now);
  store.configureGroup('g1', 'leader', ['admin', 'admin2']);
  store.configureGroup('g2', 'other-leader', ['other-admin']);
});
afterEach(() => store.close());
async function announce(text = announcement) {
  const original = message(text); await bot.handle(original);
  return { original, preview: adapter.sent.at(-1)! };
}
describe('admin workflow and permissions', () => {
  it('previews and saves all three Sudanese assignments only after approval of the exact message', async () => {
    const { original, preview } = await announce(sudaneseAnnouncement);
    expect(preview.groupId).toBe('g1');
    expect(preview.replyTo).toBe(original.id);
    for (const [index, draft] of expectedAssignments.entries()) {
      expect(preview.text).toContain(`${index + 1}. ${draft.course} — ${draft.name}`);
      expect(preview.text).toContain(draft.destination!);
    }
    expect(preview.text).toContain('2027-05-20 18:00');
    expect(preview.text).toContain('2027-05-21 12:30');
    expect(preview.text).toContain('2027-05-22 20:15');
    expect(store.upcoming('g1', now())).toHaveLength(0);
    await bot.handle(message('نعم', 'student', preview.id));
    await bot.handle(message('نعم', 'admin', original.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    await bot.handle(message('نعم', 'admin', preview.id));
    expect(store.upcoming('g1', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
    expect(store.upcoming('g2', now())).toHaveLength(0);
    expect(store.db.prepare('SELECT original_id,position FROM assignments ORDER BY position').all()).toEqual([1, 2, 3].map(position => ({ original_id: original.id, position })));
    expect(adapter.sent.at(-1)?.text).toContain('بنجاح');
  });
  it('blocks the whole three-assignment batch until its missing deadline is corrected', async () => {
    const { preview } = await announce(missingDeadlineAnnouncement);
    expect(preview.text).toContain('3. الرياضيات');
    expect(preview.text).toContain('Missing or ambiguous deadline');
    await bot.handle(message('yes', 'admin', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    expect(store.confirmation('g1', preview.id)).toBeDefined();
    await bot.handle(message('!edit 3 deadline=2027-05-22 20:15', 'student', preview.id));
    expect(store.confirmation('g1', preview.id)).toBeDefined();
    await bot.handle(message('!edit 3 deadline=2027-05-22 20:15', 'admin', preview.id));
    const replacement = adapter.sent.at(-1)!;
    expect(store.confirmation('g1', preview.id)).toBeUndefined();
    await bot.handle(message('yes', 'admin2', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    await bot.handle(message('yes', 'admin', replacement.id));
    expect(store.upcoming('g1', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
  });
  it('saves exactly three rows despite replay, sibling previews and competing admins', async () => {
    const { original, preview } = await announce(sudaneseAnnouncement);
    const drafts = JSON.parse(store.confirmation('g1', preview.id)!.drafts);
    store.addConfirmation('g1', 'sibling-three', original.id, drafts);
    await bot.handle(original);
    expect(adapter.sent).toHaveLength(1);
    await Promise.all([
      bot.handle(message('yes', 'admin', preview.id)),
      bot.handle(message('نعم', 'admin2', 'sibling-three')),
      bot.handle(message('yes', 'admin2', preview.id)),
    ]);
    await bot.handle(original);
    await bot.handle(message('yes', 'admin', preview.id));
    expect(store.upcoming('g1', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
    expect(store.confirmation('g1', 'sibling-three')).toBeUndefined();
    expect(adapter.sent.filter(m => m.text.includes('بنجاح'))).toHaveLength(1);
    expect(() => store.db.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline) VALUES(?,?,?,?,?)').run('g1', original.id, 2, '{}', expectedAssignments[1]!.deadline!)).toThrow(/UNIQUE/);
  });
  it('monitors only authorized groups and their specific leader', async () => {
    await bot.handle(message(announcement, 'student'));
    await bot.handle(message(announcement, 'leader', undefined, 'unknown'));
    await bot.handle(message(announcement, 'leader', undefined, 'g2'));
    expect(adapter.sent).toHaveLength(0);
  });
  it('quotes the original announcement and previews numbered assignments', async () => {
    const { original, preview } = await announce(announcement + '\n\nCourse: CS\nproject due 2027-05-21 14:00');
    expect(preview.replyTo).toBe(original.id);
    expect(preview.text).toContain('1. Math'); expect(preview.text).toContain('2. CS');
    expect(preview.text).toContain('هل تريد تسجيل التكليفات؟');
  });
  it('requires an admin replying to the exact confirmation in the correct group', async () => {
    const { original, preview } = await announce();
    await bot.handle(message('yes', 'student', preview.id));
    await bot.handle(message('yes', 'admin'));
    await bot.handle(message('yes', 'admin', original.id));
    await bot.handle(message('yes', 'other-admin', preview.id, 'g2'));
    expect(store.upcoming('g1', now())).toHaveLength(0);
  });
  it.each(['نعم', 'يس', 'yes', 'y', 'YES'])('accepts %s and persists original ID', async token => {
    const { original, preview } = await announce();
    await bot.handle(message(token, 'admin', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(1);
    expect(store.db.prepare('SELECT original_id FROM assignments').get()?.original_id).toBe(original.id);
    expect(store.upcoming('g2', now())).toHaveLength(0);
    expect(adapter.sent.at(-1)?.text).toContain('بنجاح');
  });
  it.each(['no', 'لا'])('rejects with %s and invalidates confirmations', async token => {
    const { preview } = await announce();
    await bot.handle(message(token, 'admin', preview.id));
    await bot.handle(message('yes', 'admin2', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    expect(store.confirmation('g1', preview.id)).toBeUndefined();
  });
  it('requires deadline correction and invalidates the old preview after editing', async () => {
    const { preview } = await announce('المادة: الرياضيات\nعندنا واجب تسليم بكرة');
    await bot.handle(message('yes', 'admin', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    await bot.handle(message('!edit 1 deadline=2027-05-20 18:00', 'admin', preview.id));
    const replacement = adapter.sent.at(-1)!;
    expect(store.confirmation('g1', preview.id)).toBeUndefined();
    await bot.handle(message('yes', 'admin2', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
    await bot.handle(message('yes', 'admin', replacement.id));
    expect(store.upcoming('g1', now())).toHaveLength(1);
  });
  it('edits individual fields and rejects out-of-range indices', async () => {
    const { preview } = await announce();
    await bot.handle(message('!edit 9 name=New', 'admin', preview.id));
    expect(store.confirmation('g1', preview.id)).toBeDefined();
    await bot.handle(message('!edit 1 name=New', 'admin', preview.id));
    const replacement = adapter.sent.at(-1)!;
    await bot.handle(message('yes', 'admin', replacement.id));
    expect(JSON.parse(store.upcoming('g1', now())[0]!.data).name).toBe('New');
  });
  it('blocks past deadlines', async () => {
    const { preview } = await announce('assignment due 2020-01-01 12:00');
    await bot.handle(message('yes', 'admin', preview.id));
    expect(store.upcoming('g1', now())).toHaveLength(0);
  });
  it('deduplicates replayed announcements and simultaneous admin approvals', async () => {
    const { original, preview } = await announce();
    await bot.handle(original); expect(adapter.sent).toHaveLength(1);
    await Promise.all([bot.handle(message('yes', 'admin', preview.id)), bot.handle(message('نعم', 'admin2', preview.id))]);
    expect(store.upcoming('g1', now())).toHaveLength(1);
  });
  it('list and help stay within the group', async () => {
    const { preview } = await announce(); await bot.handle(message('yes', 'admin', preview.id));
    await bot.handle(message('!list', 'other-admin', undefined, 'g2'));
    expect(adapter.sent.at(-1)?.text).toContain('لا توجد');
    await bot.handle(message('!help', 'student'));
    expect(adapter.sent.at(-1)?.text).toContain('!edit');
  });
  it('retains the draft and pending delivery after an adapter failure for later recovery', async () => {
    const original = message(announcement);
    const broken = new Bot(store, { send: async () => { throw new Error('mock transport failure'); } }, now);
    await expect(broken.handle(original)).resolves.toBeUndefined();
    await bot.handle(original); expect(adapter.sent).toHaveLength(0);
    const delivery = new ReminderWorker(store, adapter, () => true, () => '2027-01-01T00:00:01.000Z', 60000, () => {});
    await delivery.flushOutgoing(); expect(adapter.sent).toHaveLength(1);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM confirmations').get()!.count).toBe(1);
  });
});

describe('SQLite persistence and transactions', () => {
  it('rolls back earlier rows when the second assignment in a batch fails, then permits retry', async () => {
    const { original, preview } = await announce(sudaneseAnnouncement);
    store.db.exec(`CREATE TRIGGER fail_second_assignment BEFORE INSERT ON assignments
      WHEN NEW.position=2 BEGIN SELECT RAISE(ABORT, 'simulated database failure'); END;`);
    await expect(bot.handle(message('yes', 'admin', preview.id))).rejects.toThrow('simulated database failure');
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM assignments').get()?.count).toBe(0);
    expect(store.db.prepare('SELECT status FROM announcements WHERE message_id=?').get(original.id)?.status).toBe('pending');
    expect(store.confirmation('g1', preview.id)).toBeDefined();
    expect(adapter.sent.filter(m => m.text.includes('بنجاح'))).toHaveLength(0);
    store.db.exec('DROP TRIGGER fail_second_assignment');
    await bot.handle(message('yes', 'admin2', preview.id));
    expect(store.upcoming('g1', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
  });
  it('keeps identical original message IDs independent across authorized groups', async () => {
    const original = message(sudaneseAnnouncement);
    await bot.handle(original);
    const firstPreview = adapter.sent.at(-1)!;
    await bot.handle({ ...original, groupId: 'g2', senderId: 'other-leader' });
    const secondPreview = adapter.sent.at(-1)!;
    await bot.handle(message('yes', 'admin', firstPreview.id));
    expect(store.upcoming('g1', now())).toHaveLength(3);
    expect(store.upcoming('g2', now())).toHaveLength(0);
    expect(store.confirmation('g2', secondPreview.id)).toBeDefined();
    await bot.handle(message('yes', 'other-admin', secondPreview.id, 'g2'));
    expect(store.upcoming('g1', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
    expect(store.upcoming('g2', now()).map(row => JSON.parse(row.data))).toEqual(expectedAssignments);
  });
  it('retains drafts across restart and prevents approvals through two connections', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'assignment-bot-'));
    const path = join(folder, 'test.sqlite');
    let first: Store | undefined, second: Store | undefined;
    try {
      first = new Store(path); first.configureGroup('g1', 'leader', ['admin']);
      const local = new Bot(first, adapter, now);
      const original = message(announcement); await local.handle(original);
      const preview = adapter.sent.at(-1)!;
      first.close(); first = undefined;
      first = new Store(path); second = new Store(path);
      expect(first.approve('g1', preview.id, now())).toBe('saved');
      expect(second.approve('g1', preview.id, now())).toBe('stale');
      expect(second.upcoming('g1', now())).toHaveLength(1);
      expect(() => second!.db.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline) VALUES(?,?,?,?,?)').run('g1', original.id, 1, '{}', '2027-05-20')).toThrow();
    } finally { first?.close(); second?.close(); rmSync(folder, { recursive: true, force: true }); }
  });
  it('invalidates every sibling confirmation for an approved announcement', async () => {
    const { original, preview } = await announce();
    const drafts = JSON.parse(store.confirmation('g1', preview.id)!.drafts);
    store.addConfirmation('g1', 'sibling', original.id, drafts);
    expect(store.approve('g1', preview.id, now())).toBe('saved');
    expect(store.approve('g1', 'sibling', now())).toBe('stale');
  });
  it('rolls back the entire approval if an assignment insert fails', async () => {
    const { original, preview } = await announce();
    store.db.prepare('INSERT INTO assignments(group_id,original_id,position,data,deadline) VALUES(?,?,?,?,?)').run('g1', original.id, 1, '{}', '2027-05-20');
    expect(() => store.approve('g1', preview.id, now())).toThrow();
    expect(store.confirmation('g1', preview.id)).toBeDefined();
    expect(store.db.prepare('SELECT status FROM announcements WHERE message_id=?').get(original.id)?.status).toBe('pending');
  });
});
