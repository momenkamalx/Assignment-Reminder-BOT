import { WhatsAppRuntime, type RuntimeDependencies } from '../whatsapp/runtime.js';

/** No database, bot, receive handler, worker, or message-sending capability. */
export function pairingRuntime(deps: RuntimeDependencies) {
  return new WhatsAppRuntime({ authorized: () => false, attach: () => {} }, {
    ...deps,
    createSocket: auth => {
      const socket = deps.createSocket(auth);
      // Defense in depth: any accidental application send is rejected locally.
      socket.sendMessage = async () => { throw new Error('Messages prohibited in pairing-only mode.'); };
      return socket;
    },
  });
}
