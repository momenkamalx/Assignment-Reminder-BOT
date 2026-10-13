import { DateTime } from 'luxon';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import type { Store } from '../database.js';

export interface GroupConfig { id: string; leader: string; admins: string[]; timezone: string }
export const isGroupId = (id: string) => /^\d+(?:-\d+)?@g\.us$/.test(id);
export function normalizePerson(value: string): string {
  const id = jidNormalizedUser(value);
  if (!/^\d+@(s\.whatsapp\.net|lid)$/.test(id)) throw new Error('Invalid person JID: use a phone-number or LID JID.');
  return id;
}
export function parseGroups(input: unknown): GroupConfig[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Configure at least one authorized group.');
  const ids = new Set<string>();
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid group configuration.');
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' || !isGroupId(g.id) || ids.has(g.id)) throw new Error('Invalid or duplicate group JID.');
    if (typeof g.leader !== 'string' || !Array.isArray(g.admins) || !g.admins.length || !g.admins.every(a => typeof a === 'string')) throw new Error('Each group needs a leader and explicit admins.');
    const timezone = typeof g.timezone === 'string' ? g.timezone : 'Africa/Khartoum';
    if (!DateTime.now().setZone(timezone).isValid) throw new Error('Invalid group timezone.');
    ids.add(g.id);
    return { id: g.id, leader: normalizePerson(g.leader), admins: [...new Set(g.admins.map(a => normalizePerson(a as string)))], timezone };
  });
}
/** The file is the complete allowlist, including removals. Validate before writing. */
export function applyGroups(store: Store, groups: GroupConfig[]) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const group of groups) store.configureGroup(group.id, group.leader, group.admins, group.timezone);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
