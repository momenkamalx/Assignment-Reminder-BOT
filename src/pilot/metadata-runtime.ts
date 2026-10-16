import { DEFAULT_CONNECTION_CONFIG, jidNormalizedUser, type AuthenticationState, type BaileysEventMap, type BinaryNode, type Contact } from '@whiskeysockets/baileys';
import { makeSocket } from '@whiskeysockets/baileys/lib/Socket/socket.js';
import pino from 'pino';
import { identifyPrivateGroup, type MetadataRequest } from './metadata.js';

export interface MetadataSocket {
  ev: { on(event: string, handler: (...args: never[]) => void): unknown; off(event: string, handler: (...args: never[]) => void): unknown };
  user?: Contact;
  query(node: BinaryNode): Promise<BinaryNode>;
  end(error: undefined): unknown;
}
export function createMetadataSocket(auth: AuthenticationState): MetadataSocket {
  // Base socket only: no chat receiver, group dirty-bit enumeration, sends or community layers.
  const socket = makeSocket({ ...DEFAULT_CONNECTION_CONFIG, auth, logger: pino({ level: 'silent' }), markOnlineOnConnect: false,
    syncFullHistory: false, shouldSyncHistoryMessage: () => false, shouldIgnoreJid: () => true,
    connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 20_000 });
  socket.ws.removeAllListeners('CB:iq,type:set,pair-device');
  socket.ws.removeAllListeners('CB:iq,,pair-success');
  return socket as unknown as MetadataSocket;
}
export async function runMetadataOnly(request: MetadataRequest, expectedAccount: string, deps: {
  createSocket(): MetadataSocket; saveCreds(): Promise<void>;
}, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Metadata cancelled.');
  const socket = deps.createSocket();
  let pendingSave = Promise.resolve();
  let rejectConnection: (error: Error) => void = () => {};
  let closed = false;
  const abort = () => { closed = true; rejectConnection(new Error('Metadata cancelled.')); void socket.end(undefined); };
  const credentials = () => { pendingSave = pendingSave.then(() => deps.saveCreds()).catch(() => { abort(); throw new Error('Session persistence failed.'); }); void pendingSave.catch(() => {}); };
  let update: (event: BaileysEventMap['connection.update']) => void = () => {};
  const timeout = setTimeout(abort, 90_000);
  try {
    await new Promise<void>((resolve, reject) => {
      rejectConnection = reject;
      update = event => {
        if (event.qr || event.connection === 'close') { closed = true; reject(new Error('Existing session requires attention; no pairing attempted.')); void socket.end(undefined); }
        if (event.connection === 'open' && !closed) {
          if (![socket.user?.id, socket.user?.lid].some(id => id && jidNormalizedUser(id) === expectedAccount)) { abort(); return; }
          resolve();
        }
      };
      socket.ev.on('connection.update', update as (...args: never[]) => void);
      socket.ev.on('creds.update', credentials);
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (closed || !socket.user) throw new Error('Connection unavailable.');
    const result = await identifyPrivateGroup(request, socket.user, async node => {
      if (closed || signal?.aborted) throw new Error('Connection unavailable.');
      const response = await socket.query(node);
      if (closed || signal?.aborted) throw new Error('Connection unavailable.');
      return response;
    });
    if (closed || signal?.aborted) throw new Error('Metadata cancelled.');
    return result;
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort);
    socket.ev.off('connection.update', update as (...args: never[]) => void);
    socket.ev.off('creds.update', credentials);
    await socket.end(undefined);
    await pendingSave;
  }
}
