import { readFile, realpath } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { externalAuthPath } from '../whatsapp/auth-path.js';
import { normalizePerson, parseGroups } from '../whatsapp/config.js';
import { validateSavedSession } from './session.js';

export async function pilotConfig(mode: 'pair' | 'live' | 'metadata' | 'one-shot' | 'configure', env: NodeJS.ProcessEnv = process.env, root = process.cwd()) {
  const requireFlag = (name: string) => { if (env[name] !== 'true') throw new Error(`Missing approval: ${name}`); };
  requireFlag('PILOT_OWNER_CONSENT');
  requireFlag('PILOT_AUTH_DIR_APPROVED');
  requireFlag('PILOT_AUTH_PERMISSIONS_CONFIRMED');
  requireFlag(({ pair: 'PILOT_PAIRING_APPROVED', metadata: 'PILOT_METADATA_APPROVED', live: 'PILOT_LIVE_APPROVED', 'one-shot': 'PILOT_ONESHOT_APPROVED', configure: 'PILOT_CONFIG_APPROVED' })[mode]);
  if (env.WHATSAPP_ENABLE_LIVE !== (mode === 'live' ? 'true' : 'false')) throw new Error('Incorrect live messaging flag.');
  if (!env.LOCALAPPDATA || !isAbsolute(env.LOCALAPPDATA)) throw new Error('LOCALAPPDATA must be an absolute directory.');
  const expectedAuth = resolve(env.LOCALAPPDATA, 'AssignmentReminderBot/pilot-auth');
  if (!env.WHATSAPP_AUTH_DIR || resolve(env.WHATSAPP_AUTH_DIR) !== expectedAuth) throw new Error('Explicit pilot authentication path required.');
  const authDir = await externalAuthPath(expectedAuth, root);
  const directory = resolve(root, 'data/pilot');
  if (await realpath(directory) !== directory) throw new Error('Redirected pilot directory refused.');
  const groupPath = resolve(directory, 'groups.json');
  const database = resolve(directory, 'pilot.sqlite');
  if (!env.GROUPS_CONFIG_PATH || resolve(root, env.GROUPS_CONFIG_PATH) !== groupPath ||
      !env.DATABASE_PATH || resolve(root, env.DATABASE_PATH) !== database) throw new Error('Explicit isolated pilot paths required.');
  for (const path of [groupPath, database]) {
    if (await realpath(path) !== path) throw new Error('Redirected pilot file refused.');
  }
  const input: unknown = JSON.parse(await readFile(groupPath, 'utf8'));
  if (mode === 'metadata' || mode === 'one-shot' || mode === 'configure') {
    if (!Array.isArray(input) || input.length !== 0) throw new Error('Metadata mode requires an empty allowlist.');
    const saved = JSON.parse(await readFile(resolve(authDir, 'creds.json'), 'utf8')) as { me?: { id?: string } };
    const expectedAccount = normalizePerson(env.PILOT_EXPECTED_ACCOUNT_JID || saved.me?.id || '');
    await validateSavedSession(resolve(authDir, 'creds.json'), expectedAccount);
    return { authDir, database, groups: [], expectedAccount };
  }
  if (mode === 'pair') {
    if (!Array.isArray(input) || input.length !== 0) throw new Error('Pairing requires an empty allowlist.');
    return { authDir, database, groups: [], expectedAccount: undefined };
  }
  const groups = parseGroups(input);
  if (groups.length !== 1 || groups[0]!.timezone !== 'Africa/Khartoum' || (groups[0]!.reminders?.mentions ?? 'none') !== 'none') {
    throw new Error('Live pilot requires exactly one Khartoum test group and disabled mentions.');
  }
  if (!env.PILOT_EXPECTED_ACCOUNT_JID) throw new Error('Verify the spare account identity first.');
  const expectedAccount = normalizePerson(env.PILOT_EXPECTED_ACCOUNT_JID);
  await validateSavedSession(resolve(authDir, 'creds.json'), expectedAccount);
  return { authDir, database, groups, expectedAccount };
}
