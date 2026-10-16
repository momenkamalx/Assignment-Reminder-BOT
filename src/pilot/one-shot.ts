import { randomBytes } from 'node:crypto';
import { writeFile, readFile, realpath } from 'node:fs/promises';
import { DEFAULT_CONNECTION_CONFIG, jidNormalizedUser, type AuthenticationState, type BaileysEventMap, type BinaryNode, type Contact, type WAMessage } from '@whiskeysockets/baileys';
import { makeMessagesSocket } from '@whiskeysockets/baileys/lib/Socket/messages-send.js';
import pino from 'pino';
import { isGroupId } from '../whatsapp/config.js';

export interface OneShotSocket {
  user?: Contact;
  ev: { on(event: string, callback: (...args: never[]) => void): unknown; off(event: string, callback: (...args: never[]) => void): unknown };
  ws: { on(event: string, callback: (node: BinaryNode) => void): unknown; off(event: string, callback: (node: BinaryNode) => void): unknown };
  sendMessage(jid: string, content: { text: string }, options: { messageId: string }): Promise<WAMessage | undefined>;
  end(error: undefined): unknown;
}
export function createOneShotSocket(auth: AuthenticationState, target: string): OneShotSocket {
  if (!isGroupId(target)) throw new Error('Verified group required.');
  // Send layer only; messages-recv and its automatic retry handlers are never constructed.
  const socket = makeMessagesSocket({ ...DEFAULT_CONNECTION_CONFIG, auth, logger: pino({ level: 'silent' }),
    markOnlineOnConnect: false, fireInitQueries: false, emitOwnEvents: false, syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, shouldIgnoreJid: () => true, enableRecentMessageCache: false,
    maxMsgRetryCount: 0, connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 20_000 });
  for (const event of ['CB:ib,,dirty', 'CB:presence', 'CB:chatstate', 'CB:iq,type:set,pair-device', 'CB:iq,,pair-success']) socket.ws.removeAllListeners(event);
  socket.ev.removeAllListeners('connection.update'); // Disable chat initialization/presence/history hooks.
  socket.ev.removeAllListeners('creds.update');
  socket.ev.on('creds.update', update => Object.assign(auth.creds, update));
  socket.ev.removeAllListeners('lid-mapping.update');
  const send = socket.sendMessage.bind(socket);
  let used = false;
  socket.sendMessage = async (jid, content, options) => {
    if (used || jid !== target || JSON.stringify(content) !== '{"text":"online now"}' || !options ||
        Object.keys(options).length !== 1 || typeof options.messageId !== 'string') throw new Error('One-shot send prohibited.');
    used = true;
    return send(jid, content, options);
  };
  return socket as unknown as OneShotSocket;
}

export async function sendOneShot(target: string, expectedAccount: string, marker: string, deps: {
  createSocket(): OneShotSocket; saveCreds(): Promise<void>;
}, signal?: AbortSignal) {
  if (!isGroupId(target) || !expectedAccount || signal?.aborted) throw new Error('Invalid one-shot destination or state.');
  const messageId = randomBytes(16).toString('hex').toUpperCase();
  // Durable exclusive intent: even a crash or uncertain acknowledgment cannot silently repeat authorization.
  await writeFile(marker, JSON.stringify({ target, messageId, status: 'reserved' }), { flag: 'wx', mode: 0o600 });
  let status = 'failed'; let attempted = false;
  let socket: OneShotSocket | undefined; let saves = Promise.resolve();
  let rejectWait: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => { rejectWait = reject; });
  void interrupted.catch(() => {});
  let closed = false;
  const abort = () => { closed = true; rejectWait(new Error('One-shot stopped; never retry automatically.')); };
  let connection: (event: BaileysEventMap['connection.update']) => void = () => {};
  let acknowledgement: (node: BinaryNode) => void = () => {};
  const creds = () => { saves = saves.then(() => deps.saveCreds()).catch(() => { abort(); throw new Error('Authentication save failed.'); }); void saves.catch(() => {}); };
  const timeout = setTimeout(abort, 90_000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('One-shot cancelled.');
    socket = deps.createSocket();
    await Promise.race([interrupted, new Promise<void>((resolve) => {
      connection = event => {
        if (event.qr || event.connection === 'close') { abort(); return; }
        if (event.connection === 'open') {
          if (![socket?.user?.id, socket?.user?.lid].some(id => id && jidNormalizedUser(id) === expectedAccount)) { abort(); return; }
          resolve();
        }
      };
      socket!.ev.on('connection.update', connection as (...args: never[]) => void);
      socket!.ev.on('creds.update', creds);
    })]);
    if (closed || signal?.aborted) throw new Error('One-shot stopped.');
    await writeFile(marker, JSON.stringify({ target, messageId, status: 'sending' }));
    if (closed || signal?.aborted) throw new Error('One-shot stopped.');
    const accepted = new Promise<void>((resolve, reject) => {
      acknowledgement = node => {
        if (node.tag !== 'ack' || node.attrs.class !== 'message' || node.attrs.id !== messageId ||
            (node.attrs.from && node.attrs.from !== target && node.attrs.from !== 's.whatsapp.net')) return;
        if (node.attrs.error) { status = 'rejected'; reject(new Error('WhatsApp rejected the send.')); }
        else resolve();
      };
      socket!.ws.on('CB:ack,class:message', acknowledgement);
    });
    void accepted.catch(() => {});
    attempted = true; status = 'uncertain';
    const send = socket.sendMessage(target, { text: 'online now' }, { messageId });
    await Promise.race([interrupted, Promise.all([send.then(result => {
      if (result?.key.id !== messageId || result.key.remoteJid !== target || !result.key.fromMe) throw new Error('Send result uncertain.');
    }), accepted])]);
    status = 'accepted';
  } catch {
    if (status !== 'rejected') status = attempted ? 'uncertain' : 'failed';
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    socket?.ev.off('connection.update', connection as (...args: never[]) => void); socket?.ev.off('creds.update', creds);
    socket?.ws.off('CB:ack,class:message', acknowledgement);
    try { await socket?.end(undefined); await saves; } catch { if (status === 'accepted') status = 'uncertain'; }
    // Refuse redirected marker files; never touch authentication here.
    if (await realpath(marker) !== marker) throw new Error('Redirected one-shot record refused.');
    await writeFile(marker, JSON.stringify({ target, messageId, status }));
  }
  if (status !== 'accepted') throw new Error(`One-shot ${status}; no retry and no configuration applied.`);
  const recorded = JSON.parse(await readFile(marker, 'utf8'));
  if (recorded.status !== 'accepted') throw new Error('One-shot confirmation unavailable.');
}
