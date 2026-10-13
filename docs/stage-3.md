# Stage 3: persistent reminders and confirmed changes

Everything in this stage was built and tested offline. No real account was paired, no live messages were sent, and nothing was deployed. Stage 4 is still pending. No Git commit or push is made without explicit permission; the user must also supply the exact commit name.

## Safe local testing

```powershell
npm test
npm run build
npm run demo:reminders
```

The reminder demo uses an in-memory SQLite database, mock messages and a simulated clock. It registers multiple assignments/groups, separately approves an immediate reminder, confirms a deadline change and cancellation, advances the clock, and checks repeated scheduler ticks. It does not create a Baileys socket. `npm run demo` remains the original Stage 1 mock demo.

For just Stage 3 tests: `npm test -- tests/reminders.test.ts`. The Baileys tests also check wire-format mention metadata, stable message ID forwarding, and authorized participant lookup without connecting a socket. Keep `WHATSAPP_ENABLE_LIVE=false`; the live entry point remains disabled by default. Its scheduler is wired behind that same guard for a future separately authorized live test.

## Per-group settings

Local group configuration supports:

```json
{
  "id": "120363000000000000@g.us",
  "leader": "249900000001@s.whatsapp.net",
  "admins": ["249900000002@s.whatsapp.net"],
  "timezone": "Africa/Khartoum",
  "reminders": { "offsetHours": [72, 24, 2], "mentions": "none" }
}
```

24 hours is mandatory and enabled by default. 72 hours (3 days) and 2 hours are optional. The default is `{ "offsetHours": [24], "mentions": "none" }`. Changing the file requires a restart. Setting changes reconcile pending schedules for existing assignments, retain delivered jobs, and preserve message IDs. Disabling an offset cancels its unsent jobs; re-enabling it can restore unsent jobs. A send already in flight cannot be recalled by a settings change.

All timestamps and due times are stored as normalized UTC. Reminder offsets are elapsed hours, including across daylight saving transitions. Displayed deadlines use the group's configured timezone, defaulting to Africa/Khartoum. Every reminder includes the assignment ID, course, name, description when present, exact local and UTC deadline, submission method and destination/link. Unknown fields are marked unknown rather than invented.

## Late registration and downtime

Assignment registration and reminder planning are one SQLite transaction. If registration is less than 24 hours before the deadline, the bot queues a **separate** admin permission request for an immediate reminder. Reply to that specific bot request with `نعم`, `يس`, `yes`, or `y`, or reject with `لا`/`no`. Approving the assignment itself does not approve the immediate reminder. Repeated replies cannot queue a second immediate reminder. A declined immediate reminder does not disable a separately configured future 2-hour reminder. At exactly 24 hours, the normal reminder is due immediately and needs no extra approval.

An optional offset already passed when the assignment is first registered is not invented or delivered automatically. For a late registration exactly 2 hours before its deadline, the optional offset does not bypass immediate-reminder consent. After a genuine downtime period, already-planned overdue reminders are sent while the assignment is still active and before its deadline. If several offsets were missed, only the most recent overdue reminder is sent and older overdue jobs are marked skipped. Future offsets remain scheduled. No reminder is newly initiated at or after its deadline. Unanswered immediate requests also expire then.

Stage 1/2 assignments have unknown registration times. Migration 3 preserves their data and adds job storage. The scheduler plans them on recovery; if already within 24 hours, it requests admin approval rather than guessing that an immediate reminder was authorized.

## Confirmed updates and cancellations

Configured admins can request:

```text
!edit 12 deadline=2027-05-20 18:00
!edit 12 name=Updated worksheet
!delete 12
```

Supported edit fields are course, name, description, deadline, submissionMethod, destination. The number is the saved assignment ID from `!list`. Existing draft editing still uses `!edit NUMBER FIELD=VALUE` **as a reply to a draft preview**; these two commands are distinguished by quoting.

A saved change first receives an acknowledgement. The persistent scheduler sends a separate confirmation preview, normally within its 15-second polling interval. Reply to that exact preview to approve/reject. Nothing changes until approval by an admin of that group. Previews survive restarts and retry delivery after disconnection. Replayed command IDs do not create duplicate change requests. Multiple competing requests use assignment versions: the first approved change invalidates other proposals for the old version.

A confirmed deadline change atomically invalidates unsent jobs and plans the new deadline. Moving within 24 hours asks separately about an immediate reminder. Changing metadata alone preserves delivered offsets. Confirmed cancellation retains the assignment and original message ID for deduplication/audit but excludes it from `!list` and cancels unsent reminders and requests. If delivery is already in progress, a change confirmation reports that it is busy and must be retried after that send finishes; a delivered message cannot be retracted.

## Delivery reliability

Jobs persist with a unique `(assignment, version, kind, offset)` key and a stable outgoing message ID. `BEGIN IMMEDIATE` claims serialize competing SQLite connections. Each claim has an ownership token and a renewable 60-second lease. Parallel ticks on one worker share its in-flight promise; other workers cannot claim the same assignment while its lease is active. Ownership, group authorization, version, active status and deadline are checked immediately before sending.

Failures return the job to pending with persistent exponential backoff (1 second initially, capped at 5 minutes). Disconnection keeps jobs queued. Restarts recover pending jobs and expired leases, retaining their outgoing IDs. Confirmed assignment changes and prompt delivery state are transactional. Logs contain fixed error event names, not message bodies, addresses or credentials.

The mock adapter deduplicates by outgoing message ID. Baileys forwards the same `messageId` on retries, which reduces duplicate risk. **There is no end-to-end exactly-once guarantee from WhatsApp.** A crash after WhatsApp accepted a message but before SQLite records success is an uncertain outcome; recovery retries the same ID, and actual server/client deduplication still needs supervised real-device validation. A sufficiently long process pause can also outlast a lease. Send completion means the adapter returned, not that every group member read or received it. In-flight network delivery cannot be atomically cancelled with a database transaction.

## Genuine mentions investigation

The installed `@whiskeysockets/baileys@7.0.0-rc14` supports native `mentionAll: true`. Its message generator writes `contextInfo.nonJidMentions = 1`; plain `@all` text does not set this metadata. Offline serialization tests verify that difference. Primary sources: [Baileys message types](https://github.com/WhiskeySockets/Baileys/blob/master/src/Types/Message.ts) and [Baileys message generation](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/messages.ts), cross-checked against the installed release's `lib/Types/Message.d.ts` and `lib/Utils/messages.js`.

Three configurable modes exist, all opt-in beyond the default:

- `none`: no mentions and no member lookup (default).
- `native_all`: adds the visible `@all` marker **and** genuine Baileys `mentionAll` metadata.
- `individual`: fetches the authorized destination group's participant JIDs, adds visible participant labels, and passes the list via Baileys `mentions` (`contextInfo.mentionedJid`). It never fetches or tags another group's members.

Only actual reminders receive mentions; permission requests and change previews do not. Member information is used transiently and is not stored in SQLite. Native client behavior, role restrictions and notifications were not tested with a real account. Keep `none` until you authorize and perform a supervised test. This implementation does not claim that plain `@all` broadcasts to everyone.
