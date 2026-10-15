import type { DatabaseSync } from 'node:sqlite';
import { utcAfter } from '../reminders/storage.js';
import { diagnostic, noDiagnostics, type DiagnosticSink } from '../diagnostics.js';

export class PermanentDeliveryError extends Error {
  constructor(readonly reason: string, message = reason) { super(message); }
}
export class ObsoleteDeliveryError extends Error {}
export interface DeliveryClaim { table: 'outgoing_messages' | 'reminder_jobs'; id: number; token: string; attempts: number; maxAttempts: number; messageId: string }

/** Shared lease, retry, exhaustion and failure policy for reminders AND bot responses. */
export class DeliveryEngine {
  constructor(private db: DatabaseSync, private now: () => string, private leaseMs: number, private log: (event: string) => void, private diagnostics: DiagnosticSink = noDiagnostics) {}
  private state(c: DeliveryClaim) { return c.table === 'outgoing_messages' ? 'sending' : 'leased'; }
  owns(c: DeliveryClaim) {
    return !!this.db.prepare(`SELECT id FROM ${c.table} WHERE id=? AND lease_token=? AND status=? AND lease_until>?`).get(c.id, c.token, this.state(c), this.now());
  }
  async deliver(c: DeliveryClaim, send: () => Promise<string>, afterSent?: () => void) {
    const heartbeat = setInterval(() => {
      try { this.db.prepare(`UPDATE ${c.table} SET lease_until=? WHERE id=? AND lease_token=? AND status=?`).run(utcAfter(this.now(), this.leaseMs), c.id, c.token, this.state(c)); }
      catch { this.log('lease-renewal-failed'); }
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    try {
      if (!this.owns(c)) return;
      diagnostic(this.diagnostics, 'outgoing_attempted');
      const id = await send();
      if (id !== c.messageId) throw new PermanentDeliveryError('unstable_message_id');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const changed = this.db.prepare(`UPDATE ${c.table} SET status='sent',delivered_at=?,lease_token=NULL,lease_until=NULL,failure_reason=NULL WHERE id=? AND lease_token=? AND status=?`).run(this.now(), c.id, c.token, this.state(c));
        if (changed.changes) afterSent?.();
        this.db.exec('COMMIT');
        if (changed.changes) diagnostic(this.diagnostics, 'outgoing_acknowledged');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      diagnostic(this.diagnostics, 'outgoing_failed');
      const code = (error as { output?: { statusCode?: number } })?.output?.statusCode;
      const obsolete = error instanceof ObsoleteDeliveryError;
      const permanent = error instanceof PermanentDeliveryError || [400, 401, 403, 404].includes(code ?? 0);
      const terminal = permanent || c.attempts >= c.maxAttempts;
      const reason = obsolete ? 'obsolete' : error instanceof PermanentDeliveryError ? (/^[a-z_]{1,64}$/.test(error.reason) ? error.reason : 'permanent_failure') : permanent ? 'transport_rejected' : terminal ? 'retry_exhausted' : 'temporary_failure';
      const status = obsolete ? 'cancelled' : terminal ? 'failed' : 'pending';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const changed = this.db.prepare(`UPDATE ${c.table} SET status=?,next_attempt=?,lease_token=NULL,lease_until=NULL,failure_reason=?,failed_at=? WHERE id=? AND lease_token=? AND status=?`).run(status,
          utcAfter(this.now(), Math.min(300000, 1000 * 2 ** Math.min(Math.max(c.attempts - 1, 0), 9))), reason,
          terminal ? this.now() : null, c.id, c.token, this.state(c));
        if (changed.changes && status === 'failed' && c.table === 'outgoing_messages') {
          this.db.prepare("UPDATE confirmations SET delivery_error=? WHERE (group_id,message_id) IN (SELECT group_id,confirmation_id FROM outgoing_messages WHERE id=? AND kind='preview')").run(reason, c.id);
        }
        this.db.exec('COMMIT');
        if (changed.changes) this.log(status === 'failed' ? `delivery-failed:${c.messageId}:${reason}` : obsolete ? 'delivery-obsolete' : 'delivery-retry-scheduled');
      } catch (writeError) { this.db.exec('ROLLBACK'); throw writeError; }
    } finally { clearInterval(heartbeat); }
  }
}
