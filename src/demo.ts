import { Store } from './database.js';
import { Bot } from './bot.js';
import { MockWhatsAppAdapter } from './mock-adapter.js';

const store = new Store(process.env.DATABASE_PATH ?? 'data/demo.sqlite');
const adapter = new MockWhatsAppAdapter();
const bot = new Bot(store, adapter);
store.configureGroup('demo-group', 'leader', ['admin']);
try {
  const deadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16) + 'Z';
  await bot.handle({ id: `announcement-${crypto.randomUUID()}`, groupId: 'demo-group', senderId: 'leader', text: `المادة: البرمجة\nواجب\nاسم التكليف: تمارين الدوال\nالوصف: حل التمارين\nتسليم: ${deadline}\nSUST Moodle https://moodle.example.edu/task\n\nCourse: Physics\nAssignment\nName: Lab report\nDue: ${deadline}\nEmail: lecturer@example.edu` });
  const confirmation = adapter.sent.at(-1)!;
  console.log('MOCK PREVIEW\n' + confirmation.text);
  await bot.handle({ id: crypto.randomUUID(), groupId: 'demo-group', senderId: 'admin', text: 'نعم', replyTo: confirmation.id });
  console.log('\nMOCK RESPONSE\n' + adapter.sent.at(-1)!.text);
  await bot.handle({ id: crypto.randomUUID(), groupId: 'demo-group', senderId: 'student', text: '!list' });
  console.log('\nMOCK UPCOMING\n' + adapter.sent.at(-1)!.text);
} catch (error) {
  console.error('Local demo failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
} finally { store.close(); }
