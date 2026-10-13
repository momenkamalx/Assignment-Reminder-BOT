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
}];
