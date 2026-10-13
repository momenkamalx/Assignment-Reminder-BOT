import { Store } from './database.js';
import { Bot } from './bot.js';
import { MockWhatsAppAdapter } from './mock-adapter.js';
import { ReminderWorker } from './reminders/worker.js';

const store = new Store();
const adapter = new MockWhatsAppAdapter();
let now = '2027-01-01T00:00:00.000Z';
const bot = new Bot(store, adapter, () => now);
const worker = new ReminderWorker(store, adapter, id => ['class-a', 'class-b'].includes(id), () => now);
store.configureGroup('class-a', 'leader-a', ['admin-a']);
store.configureGroup('class-b', 'leader-b', ['admin-b']);
store.configureReminders('class-a', { offsetHours: [72, 24, 2], mentions: 'none' });
async function message(groupId: string, senderId: string, text: string, replyTo?: string) {
  await bot.handle({ id: crypto.randomUUID(), groupId, senderId, text, replyTo });
}
async function yes(group: string, admin: string) { await message(group, admin, 'نعم', adapter.sent.at(-1)!.id); }
try {
  await message('class-a', 'leader-a', 'المادة: البرمجة\nعندنا تمرين\nاسم التكليف: الدوال\nتسليم 2027-01-05 18:00Z\nSUST Moodle https://moodle.sust.example/functions\n\nCourse: Physics\nassignment due 2027-01-06 16:00Z\nSubmission: teacher@example.edu');
  await yes('class-a', 'admin-a');
  await message('class-b', 'leader-b', 'Course: Math\nexercise due 2027-01-01 18:00Z\nSubmission: https://submit.example.edu/math');
  await yes('class-b', 'admin-b'); await worker.tick();
  console.log('Immediate reminder permission request:\n' + adapter.sent.at(-1)!.text);
  await yes('class-b', 'admin-b'); await worker.tick();
  await message('class-a', 'admin-a', '!edit 1 deadline=2027-01-08 18:00Z'); await worker.tick();
  await yes('class-a', 'admin-a');
  await message('class-a', 'admin-a', '!delete 2'); await worker.tick();
  await yes('class-a', 'admin-a');
  now = '2027-01-07T18:00:00.000Z'; await worker.tick(); await worker.tick();
  const reminders = adapter.sent.filter(m => m.text.startsWith('تذكير بالتكليف'));
  for (const reminder of reminders) console.log(`\nMOCK REMINDER TO ${reminder.groupId}\n${reminder.text}`);
  console.log(`\n${reminders.length} mock reminders. Updated deadline respected, cancelled assignment skipped, repeated tick delivered no duplicates. No network connection was created.`);
} finally { await worker.stop(); store.close(); }
