import { readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { useMultiFileAuthState, jidNormalizedUser } from '@whiskeysockets/baileys';
import { pilotConfig } from './config.js';
import { parseMetadataRequest } from './metadata.js';
import { createMetadataSocket, runMetadataOnly } from './metadata-runtime.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const config = await pilotConfig('metadata');
  const path = resolve('data/pilot/metadata-request.json');
  if (await realpath(path) !== path) throw new Error('Redirected input refused.');
  const output = resolve('data/pilot/metadata-result.json');
  try { await lstat(output); throw new Error('Existing result requires operator review.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const request = parseMetadataRequest(JSON.parse(await readFile(path, 'utf8')));
  if (controller.signal.aborted) throw new Error('Cancelled.');
  const auth = await useMultiFileAuthState(config.authDir);
  if (jidNormalizedUser(auth.state.creds.me?.id ?? '') !== config.expectedAccount) throw new Error('Session changed.');
  const result = await runMetadataOnly(request, config.expectedAccount!, {
    createSocket: () => createMetadataSocket(auth.state), saveCreds: auth.saveCreds,
  }, controller.signal);
  if (controller.signal.aborted) throw new Error('Cancelled.');
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Private group verified; spare account is a member; leader verified; ${result.identities.admins.length} selected admin(s) verified.`);
  console.log('Proposed identities/configuration saved locally in ignored data/pilot/metadata-result.json. Operational allowlist unchanged, mentions disabled, connection stopped.');
} catch {
  console.error('Metadata identification refused or failed. Check local request, membership, approvals and existing session. No configuration enabled; private values omitted.');
  process.exitCode = 1;
} finally {
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
}
