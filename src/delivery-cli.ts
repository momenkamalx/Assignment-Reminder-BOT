import { Store } from './database.js';

// Local database inspection/recovery only. No Baileys imports, pairing or transport creation.
const store = new Store(process.env.DATABASE_PATH ?? 'data/bot.sqlite');
try {
  const [command = 'status', group, id] = process.argv.slice(2);
  if (command === 'status') {
    const groups = group ? [{ id: group }] : store.db.prepare('SELECT id FROM groups').all() as { id: string }[];
    for (const item of groups) console.log(JSON.stringify({ group: item.id, ...store.deliveryReport(item.id) }));
  } else if (command === 'retry' && group && id) {
    const ok = store.retryDelivery(group, id, new Date().toISOString());
    console.log(ok ? 'Requeued the existing message ID. A configured worker must deliver it.' : 'No eligible failed delivery. Nothing changed.');
    if (!ok) process.exitCode = 1;
  } else { console.error('Usage: npm run delivery -- status [GROUP_ID] | retry GROUP_ID MESSAGE_ID'); process.exitCode = 1; }
} finally { store.close(); }
