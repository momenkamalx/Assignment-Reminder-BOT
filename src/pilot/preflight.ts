import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Store } from '../database.js';
import { parseGroups } from '../whatsapp/config.js';
import { verifiedProposal } from './proposal.js';

export async function checkPilot(root = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env.WHATSAPP_ENABLE_LIVE !== 'false') throw new Error('Live messaging must remain disabled.');
  const dir = resolve(root, 'data/pilot'); const path = resolve(dir, 'groups.json'); const database = resolve(dir, 'pilot.sqlite');
  if (await realpath(dir) !== dir || await realpath(path) !== path || await realpath(database) !== database ||
      resolve(root, env.GROUPS_CONFIG_PATH ?? '') !== path || resolve(root, env.DATABASE_PATH ?? '') !== database) throw new Error('Isolated pilot paths required.');
  const input = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(input)) throw new Error('Invalid allowlist.');
  const groups = input.length ? parseGroups(input) : [];
  if (groups.length) {
    const proposal = verifiedProposal(JSON.parse(await readFile(resolve(dir, 'metadata-result.json'), 'utf8')));
    if (JSON.stringify(groups) !== JSON.stringify(proposal.groups)) throw new Error('Allowlist differs from the verified single group.');
  }
  const store = new Store(database);
  try {
    if (store.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Database integrity check failed.');
    const count = (table: string) => Number(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
    if (count('assignments') || count('outgoing_messages') || count('reminder_jobs')) throw new Error('Unexpected pilot assignments or queued messages.');
    const rows = store.db.prepare('SELECT id,leader,admins,timezone,reminder_settings FROM groups').all();
    if (rows.length !== groups.length) throw new Error('Database group count differs from configuration.');
    for (const group of groups) {
      const row = rows.find(row => row.id === group.id);
      if (!row || row.leader !== group.leader || row.admins !== JSON.stringify(group.admins) || row.timezone !== group.timezone ||
          JSON.stringify(JSON.parse(row.reminder_settings as string)) !== JSON.stringify(group.reminders)) throw new Error('Database permissions/settings differ.');
    }
    return { authorizedGroups: groups.length, assignments: 0, outgoingMessages: 0, reminderJobs: 0, mentions: 'none', liveMessaging: false, integrity: 'ok' };
  } finally { store.close(); }
}
