import makeWASocket, { DisconnectReason, useMultiFileAuthState, type BaileysEventMap, type AuthenticationState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mkdir, chmod } from 'node:fs/promises';
import { BaileysAdapter, type Socket } from './adapter.js';

export interface RuntimeDependencies {
  loadAuth: () => Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }>;
  createSocket: (auth: AuthenticationState) => Socket;
  qr: (value: string) => void;
  log: (event: string) => void;
}
export class WhatsAppRuntime {
  private socket?: Socket;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private attempts = 0;
  private generation = 0;
  private tasks: Promise<void> = Promise.resolve();
  private unbind?: () => void;
  constructor(private adapter: BaileysAdapter, private deps: RuntimeDependencies) {}
  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    try { await this.connect(); } catch (error) { this.stop(); throw error; }
  }
  private async connect() {
    const generation = ++this.generation;
    const auth = await this.deps.loadAuth();
    if (this.stopped || generation !== this.generation) return;
    const socket = this.deps.createSocket(auth.state);
    this.socket = socket; this.adapter.attach(socket);
    const active = () => !this.stopped && this.socket === socket && generation === this.generation;
    const enqueue = (task: () => Promise<void>, finishAfterDisconnect = false) => {
      this.tasks = this.tasks.then(async () => { if (finishAfterDisconnect || active()) await task(); }).catch(() => {
        this.deps.log('whatsapp-handler-error'); // No message bodies, credentials, QR or raw errors.
      });
    };
    const creds = () => { if (active()) enqueue(async () => {
      try { await auth.saveCreds(); } catch { this.deps.log('auth-save-failed'); this.stop(); }
    }, true); };
    const messages = (event: BaileysEventMap['messages.upsert']) => enqueue(() => this.adapter.receive(event));
    const connection = (update: BaileysEventMap['connection.update']) => {
      if (!active()) return;
      if (update.qr) this.deps.qr(update.qr);
      if (update.connection === 'open') { this.attempts = 0; this.adapter.attach(socket, true); this.deps.log('whatsapp-connected'); }
      if (update.connection === 'close') {
        const code = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        this.detach();
        if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(code as number)) {
          this.stopped = true; this.deps.log('whatsapp-session-requires-attention'); return;
        }
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5));
        this.deps.log('whatsapp-reconnecting');
        this.scheduleReconnect(delay);
      }
    };
    socket.ev.on('creds.update', creds);
    socket.ev.on('messages.upsert', messages);
    socket.ev.on('connection.update', connection);
    this.unbind = () => {
      socket.ev.off('creds.update', creds); socket.ev.off('messages.upsert', messages); socket.ev.off('connection.update', connection);
    };
  }
  private detach() {
    this.unbind?.(); this.unbind = undefined;
    const previous = this.socket; this.socket = undefined;
    this.adapter.attach(); previous?.end(undefined);
  }
  private scheduleReconnect(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tasks.then(async () => { if (!this.stopped) await this.connect(); }).catch(() => {
        this.deps.log('whatsapp-reconnect-failed');
        this.detach();
        if (!this.stopped) this.scheduleReconnect(Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)));
      });
    }, delay);
  }
  stop() { this.stopped = true; ++this.generation; clearTimeout(this.timer); this.timer = undefined; this.detach(); }
  async idle() { await this.tasks; }
}

export function liveDependencies(adapter: BaileysAdapter, authDir: string, qr: (value: string) => void): RuntimeDependencies {
  return {
    loadAuth: async () => {
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(authDir, 0o700);
      return useMultiFileAuthState(authDir);
    },
    createSocket: auth => makeWASocket({
      auth, logger: pino({ level: 'silent' }), markOnlineOnConnect: false,
      syncFullHistory: false, shouldSyncHistoryMessage: () => false,
      shouldIgnoreJid: jid => !adapter.authorized(jid),
    }),
    qr,
    log: event => console.error(`[whatsapp] ${event}`),
  };
}
