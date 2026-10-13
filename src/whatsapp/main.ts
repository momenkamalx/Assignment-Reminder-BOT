import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import qr from 'qrcode-terminal';
import { Store } from '../database.js';
import { applyGroups, parseGroups } from './config.js';
import { BaileysAdapter } from './adapter.js';
import { liveDependencies, WhatsAppRuntime } from './runtime.js';
import { externalAuthPath } from './auth-path.js';
import { ReminderWorker } from '../reminders/worker.js';

// No socket factory or auth loading is invoked unless explicitly enabled.
if (process.env.WHATSAPP_ENABLE_LIVE !== 'true') {
  console.log('Live WhatsApp is disabled. Use npm test or npm run demo for safe offline testing.');
} else {
  let store: Store | undefined;
  let runtime: WhatsAppRuntime | undefined;
  let reminders: ReminderWorker | undefined;
  try {
    const groups = parseGroups(JSON.parse(await readFile(process.env.GROUPS_CONFIG_PATH ?? 'config/groups.json', 'utf8')));
    const authDir = await externalAuthPath(process.env.WHATSAPP_AUTH_DIR?.trim() || resolve(homedir(), '.assignment-reminder-bot', 'auth'));
    if (process.platform !== 'win32') process.umask(0o077);
    store = new Store(process.env.DATABASE_PATH ?? 'data/bot.sqlite');
    applyGroups(store, groups);
    const adapter = new BaileysAdapter(store, groups);
    runtime = new WhatsAppRuntime(adapter, liveDependencies(adapter, authDir, value => qr.generate(value, { small: true })));
    reminders = new ReminderWorker(store, adapter, id => adapter.authorized(id));
    const stop = () => { runtime?.stop(); void Promise.all([runtime?.idle(), reminders?.stop()]).finally(() => { store?.close(); }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await runtime.start();
    reminders.start();
  } catch {
    runtime?.stop(); await reminders?.stop(); store?.close(); console.error('WhatsApp startup failed. Check group configuration and auth directory permissions.'); process.exitCode = 1;
  }
}
