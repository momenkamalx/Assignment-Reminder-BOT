import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { jidNormalizedUser, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pilotConfig } from './config.js';
import { verifiedProposal } from './proposal.js';
import { checkPilot } from './preflight.js';
import { Store } from '../database.js';
import { ControlledTest } from './controlled.js';
import { controlledSocket } from './controlled-socket.js';

const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };
const report = console.log.bind(console);
let store: Store | undefined; let test: ControlledTest | undefined; let socket: ReturnType<typeof controlledSocket> | undefined;
let timer: ReturnType<typeof setInterval> | undefined; let limit: ReturnType<typeof setTimeout> | undefined;
let saves = Promise.resolve(); let ending = false;
async function stop() {
  if (ending) return; ending = true; clearInterval(timer); clearTimeout(limit);
  try { await socket?.end(undefined); await test?.stop(); await saves; }
  finally { store?.close(); Object.assign(console, originalConsole); report('Controlled pilot stopped; session preserved; temporary reminder override disabled.'); }
}
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
try {
  if (process.env.PILOT_CONTROLLED_TEST !== 'true' || process.env.PILOT_REMINDER_TEST !== 'true') throw new Error('Both explicit pilot test approvals required.');
  if (process.env.PILOT_CORRECTIONS_APPROVED !== 'true') throw new Error('Correction preview/feedback message budget requires separate live approval.');
  await checkPilot(process.cwd(), { ...process.env, WHATSAPP_ENABLE_LIVE: 'false' });
  const config = await pilotConfig('live');
  const raw = JSON.parse(await readFile(resolve('data/pilot/metadata-result.json'), 'utf8'));
  const proposal = verifiedProposal(raw);
  if (JSON.stringify(config.groups) !== JSON.stringify(proposal.groups) || config.expectedAccount !== proposal.expectedAccount) throw new Error('Verified pilot mismatch.');
  const aliases = new Map<string, string>();
  const add = (person: { id: string; phoneNumber?: string; lid?: string }, canonical: string) => {
    for (const id of [person.id, person.phoneNumber, person.lid]) if (id) { const normalized = jidNormalizedUser(id); if (aliases.has(normalized) && aliases.get(normalized) !== canonical) throw new Error('Conflicting role mapping.'); aliases.set(normalized, canonical); }
  };
  add(raw.identities.leader, proposal.group.leader); raw.identities.admins.forEach((person: { id: string; phoneNumber?: string; lid?: string }, index: number) => add(person, proposal.group.admins[index]!));
  const auth = await useMultiFileAuthState(config.authDir);
  if (jidNormalizedUser(auth.state.creds.me?.id ?? '') !== proposal.expectedAccount) throw new Error('Saved account mismatch.');
  store = new Store(config.database);
  test = new ControlledTest(store, proposal.group, aliases, report, () => { setTimeout(() => { void stop(); }, 0); }, undefined, {
    maxAssignments: process.env.PILOT_MAX_ASSIGNMENTS ? Number(process.env.PILOT_MAX_ASSIGNMENTS) : undefined,
    maxPreviews: Number(process.env.PILOT_MAX_PREVIEWS ?? 32), maxFeedback: Number(process.env.PILOT_MAX_FEEDBACK ?? 8),
    reminder: { scope: 'approved-pilot', delayMs: 300000 }, diagnostics: event => report(JSON.stringify(event)),
  });
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) console[method] = () => {}; // libsignal may print private session objects.
  socket = controlledSocket(auth.state, proposal.group.id, event => test?.observe(event));
  socket.ev.on('creds.update', () => { saves = saves.then(auth.saveCreds).catch(() => { void stop(); }); });
  socket.ev.on('connection.update', event => {
    if (ending) return;
    if (event.qr || event.connection === 'close') { report('Controlled pilot connection stopped; no reconnection or re-pairing attempted.'); void stop(); return; }
    if (event.connection === 'open') {
      if (![socket!.user?.id, socket!.user?.lid].some(id => id && jidNormalizedUser(id) === proposal.expectedAccount)) { void stop(); return; }
      test!.start(socket!);
      timer = setInterval(() => { void test?.tick(); }, 1000);
      report('Controlled connection established; verified-group listener and bounded outgoing delivery loop active.');
      report('Detected assignments enter admin correction. Only valid future deadlines can register. The explicit pilot reminder is five minutes after approval for the first registered test assignment.');
    }
  });
  socket.ev.on('messages.upsert', event => { if (!ending) void test?.receive(event); });
  limit = setTimeout(() => { report('Controlled pilot time limit reached.'); void stop(); }, 25 * 60000);
} catch { report('Controlled pilot startup refused. No further messages authorized.'); await stop(); process.exitCode = 1; }
