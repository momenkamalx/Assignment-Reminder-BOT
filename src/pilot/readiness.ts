import type { receivePipelineStatus } from './controlled-socket.js';
import type { WASocket, BaileysEventMap } from '@whiskeysockets/baileys';

export type ReadinessSnapshot = Parameters<typeof readyForIncoming>[0] & ReturnType<typeof receivePipelineStatus>;

/** rc14's event-buffer on() returns its underlying EventEmitter (verified in installed source/tests). */
export function attachIncomingListener(socket: WASocket, handler: (event: BaileysEventMap['messages.upsert']) => void) {
  const originalEvents = socket.ev;
  const registered = socket.ev.on('messages.upsert', handler) as unknown as { listeners?: (name: string) => Function[] } | undefined;
  return () => socket.ev === originalEvents && typeof registered?.listeners === 'function' && registered.listeners('messages.upsert').includes(handler);
}

/** Connection authentication alone does not establish a usable receiving pipeline. */
export function readyForIncoming(state: {
  connectionOpen: boolean; pendingNotificationsReady: boolean; identityVerified: boolean; listenerAttached: boolean;
}, pipeline: ReturnType<typeof receivePipelineStatus>) {
  return state.connectionOpen && state.pendingNotificationsReady && state.identityVerified && state.listenerAttached &&
    pipeline.websocketOpen && pipeline.sameTransport && pipeline.routeAttached && pipeline.sdkHandlers > 0 && !pipeline.eventBuffering;
}
