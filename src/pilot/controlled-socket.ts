import makeWASocket, { type AuthenticationState, type BinaryNode, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { diagnostic, noDiagnostics, type DiagnosticSink } from '../diagnostics.js';

export function controlledSocket(auth: AuthenticationState, group: string, diagnostics: DiagnosticSink = noDiagnostics): WASocket {
  // SDK failures can contain decrypted text or credentials. Discard raw logs and emit only a fixed counter.
  const logger = pino({ level: 'error' }, { write: () => { diagnostic(diagnostics, 'receive_failed'); } });
  const socket = makeWASocket({ auth, logger, fireInitQueries: false, emitOwnEvents: false,
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: jid => jid !== group, enableRecentMessageCache: false, maxMsgRetryCount: 0,
    defaultQueryTimeoutMs: 20_000 });
  for (const event of ['CB:ib,,dirty', 'CB:presence', 'CB:chatstate', 'CB:receipt', 'CB:notification', 'CB:call', 'CB:ack,class:message', 'CB:iq,type:set,pair-device', 'CB:iq,,pair-success']) socket.ws.removeAllListeners(event);
  const incoming = socket.ws.listeners('CB:message'); socket.ws.removeAllListeners('CB:message');
  socket.ws.on('CB:message', (node: BinaryNode) => {
    if (node.attrs.from !== group) return; // Never inspect or retain unrelated bodies/identifiers.
    diagnostic(diagnostics, 'raw_group_message');
    if (node.attrs.offline) { diagnostic(diagnostics, 'offline_message_rejected'); return; }
    for (const handler of incoming) void Promise.resolve(handler.call(socket.ws, node)).catch(() => { diagnostic(diagnostics, 'receive_failed'); });
  });
  socket.ev.removeAllListeners('connection.update'); socket.ev.removeAllListeners('creds.update'); socket.ev.removeAllListeners('lid-mapping.update'); socket.ev.removeAllListeners('call');
  socket.ev.on('creds.update', update => Object.assign(auth.creds, update));
  const send = socket.sendMessage.bind(socket);
  socket.sendMessage = async (jid, content, options) => {
    if (jid !== group || !options?.messageId || !('text' in content) || ('mentions' in content && content.mentions?.length) || ('mentionAll' in content && content.mentionAll)) throw new Error('Pilot send blocked.');
    const id = options.messageId;
    let ack!: (node: BinaryNode) => void;
    let close!: (event: { connection?: string }) => void;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const accepted = new Promise<void>((resolve, reject) => {
      ack = node => {
        if (node.tag !== 'ack' || node.attrs.class !== 'message' || node.attrs.id !== id || (node.attrs.from && node.attrs.from !== group && node.attrs.from !== 's.whatsapp.net')) return;
        if (node.attrs.error) reject(new Error('Pilot server rejection.')); else resolve();
      };
      close = event => { if (event.connection === 'close') reject(new Error('Pilot disconnected.')); };
      timeout = setTimeout(() => reject(new Error('Pilot ACK uncertain.')), 30_000);
      socket.ws.on('CB:ack,class:message', ack); socket.ev.on('connection.update', close);
    });
    void accepted.catch(() => {});
    try {
      const result = await Promise.race([accepted.then(() => new Promise<never>(() => {})), Promise.all([send(jid, content, options), accepted]).then(([message]) => message)]);
      if (result?.key.id !== id || result.key.remoteJid !== group || !result.key.fromMe) throw new Error('Pilot result uncertain.');
      return result;
    } finally { clearTimeout(timeout); socket.ws.off('CB:ack,class:message', ack); socket.ev.off('connection.update', close); }
  };
  return socket;
}
