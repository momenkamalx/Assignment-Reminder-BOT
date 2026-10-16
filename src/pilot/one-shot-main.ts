import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { useMultiFileAuthState, jidNormalizedUser } from '@whiskeysockets/baileys';
import { pilotConfig } from './config.js';
import { verifiedProposal } from './proposal.js';
import { createOneShotSocket, sendOneShot } from './one-shot.js';

const controller = new AbortController(); const stop = () => controller.abort();
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };
const restoreConsole = () => Object.assign(console, originalConsole);
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  const config = await pilotConfig('one-shot');
  const path = resolve('data/pilot/metadata-result.json');
  if (await realpath(path) !== path) throw new Error('Redirected proposal refused.');
  const proposal = verifiedProposal(JSON.parse(await readFile(path, 'utf8')));
  if (proposal.expectedAccount !== config.expectedAccount) throw new Error('Spare account mismatch.');
  const auth = await useMultiFileAuthState(config.authDir);
  if (jidNormalizedUser(auth.state.creds.me?.id ?? '') !== config.expectedAccount) throw new Error('Session changed.');
  // libsignal can print entire session objects outside pino. Suppress library console output in this isolated command.
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[method] = () => {};
  try {
    await sendOneShot(proposal.group.id, config.expectedAccount!, resolve('data/pilot/one-shot-online-now.json'), {
      createSocket: () => createOneShotSocket(auth.state, proposal.group.id), saveCreds: auth.saveCreds,
    }, controller.signal);
  } finally { restoreConsole(); }
  console.log('SUCCESS: WhatsApp server acknowledged the single exact online now message to the verified private group. Connection closed. Recipient delivery/read status is unverified.');
} catch {
  console.error('One-shot failed or uncertain. Do not retry. Configuration was not applied. Private values omitted.'); process.exitCode = 1;
} finally { restoreConsole(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
