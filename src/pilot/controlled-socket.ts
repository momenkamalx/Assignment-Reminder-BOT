import makeWASocket, { type AuthenticationState, type BinaryNode, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { diagnostic, noDiagnostics, type DiagnosticSink } from '../diagnostics.js';
import { observeSdkLog } from './sdk-diagnostics.js';

const receiveRoutes = new WeakMap<WASocket, { ws: WASocket['ws']; handler: (node: BinaryNode) => void; sdkHandlers: number }>();
export function receivePipelineStatus(socket: WASocket) {
  const route = receiveRoutes.get(socket);
  return {
    websocketOpen: socket.ws.isOpen === true,
    sameTransport: !!route && route.ws === socket.ws,
    routeAttached: !!route && socket.ws.listeners('CB:message').includes(route.handler),
    sdkHandlers: route?.sdkHandlers ?? 0,
    eventBuffering: socket.ev.isBuffering(),
  };
}

export function controlledSocket(auth: AuthenticationState, group: string, diagnostics: DiagnosticSink = noDiagnostics): WASocket {
  // SDK failures can contain decrypted text or credentials. Discard raw logs and emit only a fixed counter.
  const logger = pino({ level: 'warn' }, { write: (line: string) => observeSdkLog(line, diagnostics) });
  const socket = makeWASocket({ auth, logger, fireInitQueries: false, emitOwnEvents: false,
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    shouldIgnoreJid: jid => jid !== group, enableRecentMessageCache: false, maxMsgRetryCount: 0,
    defaultQueryTimeoutMs: 20_000 });
  for (const event of ['CB:ib,,dirty', 'CB:presence', 'CB:chatstate', 'CB:receipt', 'CB:notification', 'CB:call', 'CB:ack,class:message', 'CB:iq,type:set,pair-device', 'CB:iq,,pair-success']) socket.ws.removeAllListeners(event);
  const incoming = socket.ws.listeners('CB:message'); socket.ws.removeAllListeners('CB:message');
  diagnostic(diagnostics, 'sdk_message_handlers', incoming.length);
  socket.ws.on('message', () => diagnostic(diagnostics, 'wire_payload_received'));
  socket.ws.on('frame', (frame: BinaryNode | Uint8Array) => {
    diagnostic(diagnostics, 'decoded_frame_received');
    diagnostic(diagnostics, !(frame instanceof Uint8Array) && frame?.tag === 'message' ? 'decoded_message_frame' :
      !(frame instanceof Uint8Array) && frame?.tag === 'notification' ? 'decoded_notification_frame' : 'decoded_other_frame');
    if (!(frame instanceof Uint8Array) && frame?.tag === 'ib' && Array.isArray(frame.content)) {
      for (const child of frame.content) {
        if (child?.tag === 'offline_preview') diagnostic(diagnostics, 'pending_offline_preview_frame');
        if (child?.tag === 'offline') diagnostic(diagnostics, 'pending_offline_marker_frame');
      }
    }
  });
  // Observers only: preserve the SDK handlers; never request batches, ACK or force completion here.
  socket.ws.on('CB:ib,,offline_preview', () => diagnostic(diagnostics, 'pending_offline_preview_callback'));
  socket.ws.on('CB:ib,,offline', () => diagnostic(diagnostics, 'pending_offline_marker_callback'));
  const incomingRoute = (node: BinaryNode) => {
    diagnostic(diagnostics, 'transport_message_received');
    if (!node?.attrs || typeof node.attrs.from !== 'string') { diagnostic(diagnostics, 'transport_key_invalid'); return; }
    if (node.attrs.from !== group) { diagnostic(diagnostics, 'transport_route_rejected'); return; } // No unrelated body inspection.
    diagnostic(diagnostics, 'raw_group_message');
    diagnostic(diagnostics, node.attrs.offline === undefined ? 'offline_flag_absent' : node.attrs.offline === '0' ? 'offline_flag_zero' : node.attrs.offline === '1' ? 'offline_flag_one' : 'offline_flag_other');
    if (node.attrs.offline) { diagnostic(diagnostics, 'offline_message_rejected'); return; }
    if (!incoming.length) diagnostic(diagnostics, 'sdk_handler_missing');
    for (const handler of incoming) {
      diagnostic(diagnostics, 'sdk_handler_forwarded');
      try { void Promise.resolve(handler.call(socket.ws, node)).catch(() => { diagnostic(diagnostics, 'receive_failed'); }); }
      catch { diagnostic(diagnostics, 'receive_failed'); }
    }
  };
  socket.ws.on('CB:message', incomingRoute);
  receiveRoutes.set(socket, {ws:socket.ws,handler:incomingRoute,sdkHandlers:incoming.length});
  // Keep SDK lifecycle, credential and LID listeners: chats.js uses these to finish sync.
  // Raw group/history gates above and removed dirty hooks still prevent unrelated processing/enumeration.
  socket.ev.removeAllListeners('call');
  socket.ev.on('creds.update', update => Object.assign(auth.creds, update));
  // Event kinds/counts only; never inspect update contents or history payloads.
  socket.ev.on('messages.update', () => diagnostic(diagnostics, 'message_update_received'));
  socket.ev.on('messaging-history.set', () => diagnostic(diagnostics, 'history_event_received'));
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
