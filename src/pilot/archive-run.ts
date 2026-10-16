import type { DatabaseSync } from 'node:sqlite';

/** Offline operator operation only. Caller must verify all bot processes are stopped. */
export function archiveEmptyPilotRun(db: DatabaseSync, now: string) {
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid archive timestamp.');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['assignments','announcements','confirmations','outgoing_messages','reminder_jobs','pilot_test_sends']) {
      if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)) throw new Error('Pilot contains activity; archive refused.');
    }
    const row = db.prepare('SELECT state FROM pilot_test_run WHERE id=1').get();
    if (!row) throw new Error('No previous run to archive.');
    const state = JSON.parse(row.state as string);
    const safelyStopped = state.status === 'stopped' && state.connected === false && state.listenerActive === false &&
      state.outgoingLoopActive === false && state.overrideEnabled === false;
    if ((state.status !== 'waiting_for_announcement' && !safelyStopped) || state.announcementId || state.assignmentId || state.reminderJobId) throw new Error('Previous run is not an empty waiting or safely stopped run.');
    db.exec('CREATE TABLE IF NOT EXISTS pilot_test_run_archive(id INTEGER PRIMARY KEY, state TEXT NOT NULL, archived_at TEXT NOT NULL, reason TEXT NOT NULL)');
    const archived = db.prepare('INSERT INTO pilot_test_run_archive(state,archived_at,reason) VALUES(?,?,?)').run(row.state as string,now,'operator_approved_empty_run_archive');
    if (db.prepare('SELECT state FROM pilot_test_run_archive WHERE id=?').get(archived.lastInsertRowid)?.state !== row.state) throw new Error('Archived run verification failed.');
    if (db.prepare('DELETE FROM pilot_test_run WHERE id=1 AND state=?').run(row.state as string).changes !== 1) throw new Error('Active run changed during archive.');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
