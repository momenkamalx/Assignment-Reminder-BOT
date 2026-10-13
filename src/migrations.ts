/** Append migrations; never edit an applied version in a released database. */
export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE groups(id TEXT PRIMARY KEY, leader TEXT NOT NULL, admins TEXT NOT NULL, timezone TEXT NOT NULL);
    CREATE TABLE announcements(group_id TEXT NOT NULL REFERENCES groups(id), message_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), PRIMARY KEY(group_id,message_id));
    CREATE TABLE confirmations(group_id TEXT NOT NULL, message_id TEXT NOT NULL, original_id TEXT NOT NULL, drafts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','invalidated')), PRIMARY KEY(group_id,message_id), FOREIGN KEY(group_id,original_id) REFERENCES announcements(group_id,message_id));
    CREATE TABLE assignments(id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, original_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>0), data TEXT NOT NULL, deadline TEXT NOT NULL, UNIQUE(group_id,original_id,position), FOREIGN KEY(group_id,original_id) REFERENCES announcements(group_id,message_id));
    CREATE INDEX upcoming_assignments ON assignments(group_id,deadline);
  `,
}, {
  version: 2,
  sql: `CREATE TABLE whatsapp_keys(group_id TEXT NOT NULL REFERENCES groups(id), message_id TEXT NOT NULL, key_json TEXT NOT NULL, PRIMARY KEY(group_id,message_id));`,
}, {
  version: 3,
  sql: `
    ALTER TABLE groups ADD COLUMN reminder_settings TEXT NOT NULL DEFAULT '{"offsetHours":[24],"mentions":"none"}';
    ALTER TABLE assignments ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled'));
    ALTER TABLE assignments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE assignments ADD COLUMN registered_at TEXT;
    CREATE TABLE reminder_jobs(
      id INTEGER PRIMARY KEY, assignment_id INTEGER NOT NULL REFERENCES assignments(id), version INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('reminder','approval','change')), offset_hours INTEGER NOT NULL,
      due_at TEXT NOT NULL, next_attempt TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','leased','awaiting_approval','sent','cancelled','expired','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT, delivered_at TEXT,
      UNIQUE(assignment_id,version,kind,offset_hours)
    );
    CREATE INDEX due_reminders ON reminder_jobs(status,next_attempt,due_at);
    CREATE TABLE assignment_changes(
      group_id TEXT NOT NULL REFERENCES groups(id), message_id TEXT NOT NULL, source_id TEXT NOT NULL,
      assignment_id INTEGER NOT NULL REFERENCES assignments(id), version INTEGER NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('update','cancel')), data TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(group_id,message_id), UNIQUE(group_id,source_id)
    );
  `,
}];
