import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { pilotConfig } from './config.js';
import { Store } from '../database.js';
import { applyGroups } from '../whatsapp/config.js';
import { BaileysAdapter } from '../whatsapp/adapter.js';
import { liveDependencies, WhatsAppRuntime } from '../whatsapp/runtime.js';
import { ReminderWorker } from '../reminders/worker.js';

if (process.env.PILOT_CONTROLLED_TEST === 'true') {
  await import('./controlled-main.js');
} else {
let store: Store | undefined;
let runtime: WhatsAppRuntime | undefined;
let worker: ReminderWorker | undefined;
try {
  const config = await pilotConfig('live');
  store = new Store(config.database);
  applyGroups(store, config.groups);
  const adapter = new BaileysAdapter(store, config.groups);
  const deps = liveDependencies(adapter, config.authDir, () => { runtime?.stop(); console.error('Session needs pairing; live pilot stopped.'); });
  deps.acceptAccount = socket => [socket.user?.id, socket.user?.lid].some(id => id && jidNormalizedUser(id) === config.expectedAccount);
  runtime = new WhatsAppRuntime(adapter, deps);
  worker = new ReminderWorker(store, adapter, id => adapter.authorized(id));
  const stop = () => { runtime?.stop(); void Promise.all([runtime?.idle(), worker?.stop()]).finally(() => store?.close()); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await runtime.start();
  worker.start();
} catch {
  runtime?.stop(); await runtime?.idle(); await worker?.stop(); store?.close();
  console.error('Controlled live pilot refused or failed. Check explicit approvals and private configuration.'); process.exitCode = 1;
}
}
