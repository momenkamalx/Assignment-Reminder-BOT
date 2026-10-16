import { DateTime } from 'luxon';
import { jidNormalizedUser, normalizeMessageContent, type BaileysEventMap, type WAMessage } from '@whiskeysockets/baileys';
import { BaileysAdapter, type Socket } from '../whatsapp/adapter.js';
import type { Store } from '../database.js';
import type { GroupConfig } from '../whatsapp/config.js';
import { extractAssignments } from '../parser.js';
import { ReminderWorker } from '../reminders/worker.js';
import { messageId } from '../reminders/storage.js';
import { PermanentDeliveryError } from '../delivery/engine.js';
import { acceptsPilotDrafts, type PilotLimits } from './validation.js';
import { diagnostic, noDiagnostics, type DiagnosticSink, type DiagnosticCode, type DiagnosticEvent } from '../diagnostics.js';
import type { ReadinessSnapshot } from './readiness.js';

export interface ControlledState {
  status: string; connected: boolean; listenerActive: boolean; outgoingLoopActive: boolean; overrideEnabled: boolean;
  announcementId?: string; listSourceId?: string; assignmentId?: number; reminderJobId?: number; reminderDueAt?: string;
  lastTickAt?: string;
  adminSourceIds?: string[]; policySignature?: string;
  diagnostics?: Partial<Record<DiagnosticCode, number>>;
  readiness?: ReadinessSnapshot;
}
export interface ControlledOptions extends PilotLimits {
  diagnosticOnly?: boolean;
  maxPreviews?: number; maxFeedback?: number; resume?: boolean; diagnostics?: DiagnosticSink;
  reminder?: { scope: 'offline-test' | 'approved-pilot'; delayMs: 300000 };
}
type Kind = 'preview' | 'success' | 'list' | 'reminder' | 'feedback';
export const pilotReminderLabel = ' تذكير تجريبي — اختبار البوت';
export class ControlledTest {
  readonly adapter: BaileysAdapter;
  private worker: ReminderWorker;
  private queue: Promise<void> = Promise.resolve();
  private stopping = false;
  private startedAtSeconds = 0;
  readonly state: ControlledState = { status: 'starting', connected: false, listenerActive: false, outgoingLoopActive: false, overrideEnabled: false };
  private diagnostics: DiagnosticSink;
  constructor(private store: Store, private group: GroupConfig, private aliases: Map<string, string>,
    private notify: (event: string) => void, private finish: () => void, private now = () => new Date().toISOString(), private options: ControlledOptions = {}) {
    const db = store.db;
    this.diagnostics = event => {
      this.state.diagnostics ??= {};
      this.state.diagnostics[event.code] = (this.state.diagnostics[event.code] ?? 0) + event.count;
      this.persist(); (options.diagnostics ?? noDiagnostics)(event);
    };
    if ((options.diagnosticOnly && options.reminder) || (options.reminder && (!['offline-test', 'approved-pilot'].includes(options.reminder.scope) || options.reminder.delayMs !== 300000)) ||
        [options.maxPreviews ?? 32, options.maxFeedback ?? 8, options.maxAssignments ?? 1].some(value => !Number.isInteger(value) || value < 1)) throw new Error('Invalid explicit pilot policy.');
    if (!options.resume && (Number(db.prepare('SELECT COUNT(*) AS n FROM assignments').get()!.n) || Number(db.prepare('SELECT COUNT(*) AS n FROM outgoing_messages').get()!.n))) throw new Error('Controlled pilot requires empty assignment/outgoing storage.');
    db.exec(`CREATE TABLE IF NOT EXISTS pilot_test_run(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pilot_test_sends(kind TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL,server_ack_at TEXT);`);
    const signature = JSON.stringify({ group, maxAssignments: options.maxAssignments, allowedMethods: options.allowedMethods, maxPreviews: options.maxPreviews ?? 32, maxFeedback: options.maxFeedback ?? 8, reminder: options.reminder, diagnosticOnly: options.diagnosticOnly });
    const existing = db.prepare('SELECT state FROM pilot_test_run WHERE id=1').get();
    if (existing) {
      const saved = JSON.parse(existing.state as string) as ControlledState;
      if (!options.resume || saved.policySignature !== signature || ['completed', 'failed_no_retry', 'stopped'].includes(saved.status) ||
          db.prepare("SELECT kind FROM pilot_test_sends WHERE status<>'accepted' LIMIT 1").get() ||
          db.prepare("SELECT id FROM outgoing_messages WHERE status='sending' LIMIT 1").get() ||
          db.prepare("SELECT id FROM reminder_jobs WHERE status='leased' LIMIT 1").get()) throw new Error('Prior run requires review; no automatic resend or policy changes.');
      Object.assign(this.state, saved, { connected: false, listenerActive: false, outgoingLoopActive: false });
    } else {
      this.state.policySignature = signature; this.state.overrideEnabled = !!options.reminder;
      db.prepare('INSERT INTO pilot_test_run(id,state) VALUES(1,?)').run(JSON.stringify(this.state));
    }
    this.adapter = new BaileysAdapter(store, [group], now, this.diagnostics);
    const send = this.adapter.send.bind(this.adapter);
    this.adapter.send = async (jid, text, reply, options) => {
      const id = options?.messageId;
      if (jid !== group.id || !id || options?.mentionAll || options?.mentions?.length || this.stopping) throw new PermanentDeliveryError('pilot_send_blocked');
      let kind: Kind | undefined;
      const q = db.prepare('SELECT kind,text,reply_to FROM outgoing_messages WHERE group_id=? AND message_id=?').get(jid, id);
      if (q?.text === text && q.kind === 'preview' && this.state.announcementId) kind = 'preview';
      else if (q?.text === text && q.kind === 'success' && this.saved().length > 0) kind = 'success';
      else if (q?.text === text && q.kind === 'feedback' && q.reply_to === this.state.listSourceId) kind = 'list';
      else if (q?.text === text && q.kind === 'feedback' && this.state.adminSourceIds?.includes(q.reply_to as string)) kind = 'feedback';
      else if (db.prepare("SELECT id FROM reminder_jobs WHERE id=? AND message_id=? AND kind='reminder' AND offset_hours=0").get(this.state.reminderJobId ?? -1, id)) kind = 'reminder';
      if (!kind) throw new PermanentDeliveryError('pilot_send_blocked');
      if (this.options.diagnosticOnly && kind !== 'preview' && kind !== 'feedback') throw new PermanentDeliveryError('pilot_diagnostic_send_blocked');
      const count = Number(db.prepare('SELECT COUNT(*) AS n FROM pilot_test_sends WHERE kind=? OR kind LIKE ?').get(kind, `${kind}:%`)!.n);
      const limit = kind === 'preview' ? this.options.maxPreviews ?? 32 : kind === 'feedback' ? this.options.maxFeedback ?? 8 : 1;
      const reservation = count ? `${kind}:${count + 1}` : kind;
      try {
        if (count >= limit) throw new Error('Pilot budget exhausted.');
        db.prepare("INSERT INTO pilot_test_sends(kind,message_id,status) VALUES(?,?,'sending')").run(reservation, id);
      }
      catch { this.state.status = 'failed_no_retry'; this.persist(); throw new PermanentDeliveryError('pilot_duplicate_blocked'); }
      try {
        const sent = await send(jid, kind === 'reminder' ? `${text}\n${pilotReminderLabel}` : text, reply, options); // Socket wrapper requires matching server ACK.
        db.prepare("UPDATE pilot_test_sends SET status='accepted',server_ack_at=? WHERE kind=?").run(this.now(), reservation);
        this.notify(`${kind}: WhatsApp server acknowledged`); return sent;
      } catch {
        db.prepare("UPDATE pilot_test_sends SET status='uncertain' WHERE kind=?").run(reservation);
        this.state.status = 'failed_no_retry'; this.persist();
        throw new PermanentDeliveryError('pilot_uncertain_no_retry');
      }
    };
    this.worker = new ReminderWorker(store, this.adapter, id => id === group.id, now, 60000, () => {}, this.diagnostics);
  }
  private persist() { this.store.db.prepare('UPDATE pilot_test_run SET state=? WHERE id=1').run(JSON.stringify(this.state)); }
  observe(event: DiagnosticEvent) { diagnostic(this.diagnostics, event.code, event.count); }
  observeReadiness(readiness: ReadinessSnapshot) {
    if (JSON.stringify(this.state.readiness) !== JSON.stringify(readiness)) { this.state.readiness = readiness; this.persist(); }
  }
  private saved() { return this.store.db.prepare('SELECT id,group_id,data,registered_at,version FROM assignments').all(); }
  private serialize(work: () => Promise<void>) {
    const task = this.queue.then(async () => { if (!this.stopping) await work(); });
    this.queue = task.catch(() => { this.state.status = 'failed_no_retry'; this.persist(); this.finish(); });
    return this.queue;
  }
  start(socket: Socket) {
    this.adapter.attach(socket, true);
    this.startedAtSeconds = Math.floor(Date.parse(this.now()) / 1000);
    Object.assign(this.state, { status: this.state.announcementId ? this.state.status : 'waiting_for_announcement', connected: true, listenerActive: true, outgoingLoopActive: true }); this.persist();
  }
  receive(event: BaileysEventMap['messages.upsert']) {
    diagnostic(this.diagnostics, 'upsert_received');
    diagnostic(this.diagnostics, event.type === 'notify' ? 'upsert_notify' : event.type === 'append' ? 'upsert_append' : 'upsert_other');
    return this.serialize(async () => {
    if (!this.state.connected) { diagnostic(this.diagnostics, 'upsert_disconnected'); return; }
    if (event.type !== 'notify') return; // History stays rejected regardless of timestamp.
    for (const raw of event.messages) {
      if (!raw?.key || typeof raw.key.remoteJid !== 'string') { diagnostic(this.diagnostics, 'message_key_invalid'); continue; }
      if (raw.key.remoteJid !== this.group.id) { diagnostic(this.diagnostics, 'group_rejected'); continue; }
      diagnostic(this.diagnostics, 'pilot_message_received'); diagnostic(this.diagnostics, 'pilot_group_matched');
      if (raw.key.fromMe) { diagnostic(this.diagnostics, 'self_message_rejected'); continue; }
      if (typeof raw.key.id !== 'string' || !raw.key.id || typeof raw.key.participant !== 'string' || !raw.key.participant ||
          (raw.key.participantAlt != null && typeof raw.key.participantAlt !== 'string')) { diagnostic(this.diagnostics, 'message_key_invalid'); continue; }
      const timestamp = raw.messageTimestamp == null ? null : Number(raw.messageTimestamp);
      diagnostic(this.diagnostics, timestamp === null ? 'timestamp_missing' : !Number.isFinite(timestamp) || timestamp <= 0 || timestamp > 1e12 ? 'timestamp_invalid' : timestamp < this.startedAtSeconds ? 'timestamp_before_start' : 'timestamp_since_start');
      const identities = [raw.key.participant, raw.key.participantAlt].filter((id): id is string => !!id).map(jidNormalizedUser);
      const roles = [...new Set(identities.map(id => this.aliases.get(id)).filter((id): id is string => !!id))];
      if (roles.length !== 1) { diagnostic(this.diagnostics, roles.length ? 'sender_conflict' : 'sender_unresolved'); diagnostic(this.diagnostics, 'leader_rejected'); continue; }
      diagnostic(this.diagnostics, 'sender_resolved');
      const role = roles[0]!;
      diagnostic(this.diagnostics, role === this.group.leader ? 'pilot_leader_matched' : 'pilot_leader_rejected');
      const content = normalizeMessageContent(raw.message);
      const text = (content?.conversation ?? content?.extendedTextMessage?.text ?? '').trim();
      const quote = content?.extendedTextMessage?.contextInfo?.stanzaId;
      let permit = false;
      if (!this.options.diagnosticOnly && text === '!list' && this.saved().length > 0 && !this.state.listSourceId) { this.state.listSourceId = raw.key.id; permit = true; }
      else if (role === this.group.leader && !quote && !this.state.announcementId) {
        diagnostic(this.diagnostics, 'pilot_parser_invoked');
        const drafts = extractAssignments(text, this.group.timezone);
        if (acceptsPilotDrafts(drafts, this.options)) {
          this.state.announcementId = raw.key.id; permit = true;
        } else diagnostic(this.diagnostics, drafts.length ? 'pilot_limit_rejected' : 'parser_empty', drafts.length);
      } else if (this.group.admins.includes(role) && ((!this.options.diagnosticOnly && /^(نعم|يس|yes|y|لا|no)$/iu.test(text)) || text.startsWith('!edit ')) && quote && this.saved().length === 0 &&
          this.store.confirmation(this.group.id, quote, this.now())) {
        this.state.adminSourceIds = [...new Set([...(this.state.adminSourceIds ?? []), raw.key.id])]; permit = true;
      } else if (role === this.group.leader && quote && !text.startsWith('!')) diagnostic(this.diagnostics, 'quoted_announcement_rejected');
      if (!permit) { diagnostic(this.diagnostics, 'pilot_message_ignored'); continue; }
      this.persist();
      // Add only previously verified phone/LID alias; retain the original quote-author identity.
      const enriched: WAMessage = { ...raw, key: { ...raw.key, participantAlt: role } };
      await this.adapter.receive({ ...event, messages: [enriched] });
      await this.afterActivity();
    }
  }); }
  private async afterActivity() {
    if (this.state.status === 'failed_no_retry') { this.finish(); return; }
    const rows = this.saved();
    if (this.options.diagnosticOnly && rows.length) throw new Error('Diagnostic pilot cannot register assignments.');
    if (!rows.length && this.store.db.prepare("SELECT kind FROM pilot_test_sends WHERE kind='preview' AND status='accepted'").get()) { this.state.status = 'waiting_for_admin'; this.persist(); }
    if ((this.options.maxAssignments !== undefined && rows.length > this.options.maxAssignments) || rows.some(row => row.group_id !== this.group.id)) throw new Error('Pilot assignment isolation failed.');
    if (rows.length > 0 && !this.state.assignmentId) {
      const row = rows[0]!;
      const previous = { ...this.state };
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        this.state.assignmentId = Number(row.id);
        if (!this.options.reminder) { this.state.status = 'registered'; this.persist(); this.store.db.exec('COMMIT'); return; }
        const due = new Date(Date.parse(row.registered_at as string) + this.options.reminder.delayMs).toISOString();
        this.state.reminderDueAt = due; this.state.status = 'waiting_for_test_reminder'; this.persist();
        // Display concrete time in the visible terminal BEFORE inserting the pilot-only schedule.
        this.notify(`Expected pilot reminder: ${DateTime.fromISO(due).setZone(this.group.timezone).toFormat('yyyy-MM-dd HH:mm:ss ZZZZ')} (${this.group.timezone}); UTC ${due}. Scheduling now.`);
        const job = this.store.db.prepare("INSERT INTO reminder_jobs(assignment_id,version,kind,offset_hours,due_at,next_attempt,message_id,status,max_attempts) VALUES(?,?,'reminder',0,?,?,?,'pending',1)").run(Number(row.id), Number(row.version), due, due, messageId());
        this.state.reminderJobId = Number(job.lastInsertRowid); this.persist();
        this.store.db.exec('COMMIT');
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        for (const key of Object.keys(this.state)) delete (this.state as unknown as Record<string, unknown>)[key];
        Object.assign(this.state, previous);
        throw error;
      }
    }
  }
  tick() { return this.serialize(async () => {
    if (!this.state.connected) return;
    this.state.lastTickAt = this.now(); this.persist();
    await this.worker.flushOutgoing(); // Only bounded authorized preview/success/list responses.
    if (this.state.status === 'failed_no_retry') { this.finish(); return; }
    await this.afterActivity(); // Recover registration committed just before a process crash.
    if (this.state.reminderDueAt && this.state.reminderDueAt <= this.now()) {
      await this.worker.tick(this.state.reminderJobId); // Only this persistent test job may be delivered.
      const job = this.store.db.prepare('SELECT status FROM reminder_jobs WHERE id=?').get(this.state.reminderJobId!);
      if (job?.status === 'sent') { this.state.status = 'completed'; this.persist(); this.finish(); }
      else if (job?.status === 'failed') { this.state.status = 'failed_no_retry'; this.persist(); this.finish(); }
    }
  }); }
  async stop() {
    this.stopping = true; this.adapter.attach();
    await this.queue; await this.worker.stop();
    // Disable only the temporary override; keep normal production offsets unchanged.
    if (this.state.reminderJobId) this.store.db.prepare("UPDATE reminder_jobs SET status='cancelled' WHERE id=? AND status IN ('pending','awaiting_approval')").run(this.state.reminderJobId);
    Object.assign(this.state, { connected: false, listenerActive: false, outgoingLoopActive: false, overrideEnabled: false });
    if (this.state.status !== 'completed' && this.state.status !== 'failed_no_retry') this.state.status = 'stopped';
    this.persist();
  }
}
