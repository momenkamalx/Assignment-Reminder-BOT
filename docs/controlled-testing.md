# Stage 4: controlled WhatsApp pilot

Current status: the spare account was paired with owner consent, its private test group and selected permissions were verified, and the single authorized `online now` message received a WhatsApp server acknowledgment. The verified group is now configured offline; continuous live messaging is disabled. No deployment was performed. The earlier sections record initial preparation and staged approval instructions; the latest verification record is at the end. Existing changes remain uncommitted; AGENTS.md contains separate pre-existing changes.

## Prepared private files

- `.env.pilot`: live access explicitly disabled, Africa/Khartoum timezone, dedicated pilot paths.
- `data/pilot/groups.json`: empty allowlist. No group or private chat is authorized.
- `data/pilot/pilot.sqlite`: separate database with migrations 1–4; development data is not used.
- `data/pilot/preflight.mjs`: offline database check, requiring disabled live access and exact pilot paths; it never imports the WhatsApp runtime or accesses authentication.

These paths are ignored by Git. Do not force-add them or copy identities, session files or databases into tracked files. Ignoring designated paths cannot prevent someone deliberately overriding Git's rules. No credentials or real phone identities have been added. Authentication has not been created: an external folder and its Windows access permissions require explicit authorization first.

## Repeat the safe preparation in Windows CMD

Open Command Prompt and paste these commands one at a time:

```cmd
cd /d "E:\ASSING BOT REM"
set "WHATSAPP_ENABLE_LIVE=false"
set "DATABASE_PATH=data/pilot/pilot.sqlite"
set "GROUPS_CONFIG_PATH=data/pilot/groups.json"
npm test
npm run build
npm audit
node --env-file=.env.pilot data/pilot/preflight.mjs
```

The preflight leaves existing pilot data intact; it is not a reset command. The empty allowlist is intentionally incomplete for live startup. Do not run `npm run whatsapp` with live access enabled: that launcher automatically starts message handling and the scheduler after pairing, and reads `.env` rather than automatically selecting `.env.pilot`.

## Next approval gate

First obtain the friend's explicit consent to use the spare account with unofficial WhatsApp automation. Account restrictions remain possible. Agree that only a small private test group will be used, and obtain its participants' consent too.

Then authorize an authentication directory outside this repository, for example `%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth`. Restrict its NTFS permissions to the account running the bot. Do not create, share or upload its contents yet. Only one process may use that authentication directory.

The dedicated `npm run pilot:pair` command is now implemented. It has no incoming-message listener, bot, database connection or delivery worker, rejects application message sends, and ignores all chat JIDs. QR authentication and serialized credential saving use the existing reconnect runtime. WhatsApp's authentication and protocol traffic still occurs when you separately authorize starting it; this is not a promise of zero network traffic. Pairing permission and message-sending permission are separate. No account password, SMS verification code or private credential file is needed from you.

The owner will use WhatsApp's Linked Devices screen to scan the terminal QR when separately authorized. The QR grants account access: keep it private. Afterwards verify locally that the connected account is the intended spare account before enabling any test-group processing. The owner can revoke the linked session from that screen; stopping Node with Ctrl+C does not unlink the account. Never intentionally log out or unlink without permission.

After pairing-only approval, obtain metadata for only the consenting private test group; verify the exact group JID and the designated leader/admin phone or LID identities. Names and group-admin titles do not grant bot permission. Configure exactly that group, Africa/Khartoum, `{ "offsetHours": [24], "mentions": "none" }`. Both native and individual mentions stay disabled. Do not collect a list of university groups.

## Later controlled tests, each requiring sending permission

The rule-based parser needs explicit field labels and unambiguous dates. The proposed natural announcement with `20 أكتوبر الساعة 11:59 مساءً` will not reliably extract all fields. Use a labelled version with a future date checked against the actual test day, for example:

```text
يا شباب عندنا واجب جديد
المادة: شبكات
اسم التكليف: Assignment 3
التسليم: 2026-10-20 23:59
طريقة التسليم: SUST Moodle
```

This example is future relative to preparation on 2026-10-13; replace it if testing later. An authorized admin must reply `نعم` to the exact bot preview. Verify the preview, database registration and success message independently; unauthorized approvals must leave the database unchanged. Test three labelled assignment blocks separated by blank lines, their distinct destinations, a quoted `!edit 2 deadline=YYYY-MM-DD HH:mm`, competing approvals and `!list` only after those sends are approved.

For a near-term 24-hour reminder, choose a dedicated assignment deadline 24 hours plus a few minutes ahead: its normal reminder becomes due in a few minutes without changing global behavior or faking the live clock. Alternatively, a short deadline requires the existing separate admin approval for an immediate reminder. Use only the pilot database and group. Observe queue/job states, message contents and repeated scheduler ticks; do not infer exactly-once recipient delivery from stable message IDs.

Later recovery tests should stop/restart Node or briefly disconnect the local network with consent, preserving the session. Check retries, quote matching and pending messages after restoration. Do not unlink the account to simulate a temporary outage. Live account identity, phone/LID mapping, quoted rendering after restart, recipient notifications, acknowledgments and server deduplication are still unverified. Keep mentions disabled throughout this pilot.

Oracle deployment is not ready: live validation, SQLite-safe backup/restore, operations and deployment authorization remain outstanding. Any commit requires explicit permission and the exact message; pushing needs separate approval.

## Pairing command — implemented, but NOT started

Do not run the following steps until the account owner consents and you explicitly authorize pairing and the external authentication folder. Approval flags are operator acknowledgments, not a substitute for that consent. This implementation has not created that folder or connected an account.

After authorization, open **Windows CMD**, create the new external folder and restrict its NTFS permissions. If the folder already exists, stop and review its existing explicit permissions rather than assuming the following command removes them:

```cmd
cd /d "E:\ASSING BOT REM"
mkdir "%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth"
icacls "%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth" /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:(OI)(CI)F"
icacls "%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth"
```

Confirm the folder grants access only to the intended operator (apart from Windows administrative ownership privileges). Never paste its credential files or QR into chat. Then, **only after pairing approval**, set these variables in the same CMD window:

```cmd
set "WHATSAPP_ENABLE_LIVE=false"
set "DATABASE_PATH=data/pilot/pilot.sqlite"
set "GROUPS_CONFIG_PATH=data/pilot/groups.json"
set "WHATSAPP_AUTH_DIR=%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth"
set "PILOT_OWNER_CONSENT=true"
set "PILOT_AUTH_DIR_APPROVED=true"
set "PILOT_AUTH_PERMISSIONS_CONFIRMED=true"
set "PILOT_PAIRING_APPROVED=true"
npm run pilot:pair
```

The private group file must still contain `[]`. Both commands require the existing isolated pilot database and refuse redirected pilot files. The pairing command refuses any populated allowlist or enabled live messaging. Missing environment/profile files, approvals or invalid paths stop before authentication loading. The NTFS acknowledgment requires your manual permissions review; the program does not claim to audit Windows ACLs.

The owner opens WhatsApp's Linked Devices screen and scans the QR shown locally. The terminal reports connection status without printing account IDs or session contents. Keep the QR private because it authorizes access. After the connection succeeds, press Ctrl+C: it stops the process and preserves authentication without logging out. A pairing-triggered reconnect can occur automatically to finish authentication. Verify the account on the owner's phone and later through locally inspected account metadata before authorizing live sends. Account/group identity discovery remains a separately supervised step, not an automatic scan of unrelated groups.

## Controlled live command — separate approval required

`npm run pilot:live` is implemented but must not be started yet. It reads `.env.pilot`, requires separate `PILOT_LIVE_APPROVED=true` and `WHATSAPP_ENABLE_LIVE=true` acknowledgments, and refuses an empty/invalid allowlist, more than one group, enabled mentions, a timezone other than Africa/Khartoum, a development database, invalid or incomplete saved authentication, or a missing verified `PILOT_EXPECTED_ACCOUNT_JID`.

After separately approving messages and verifying the private group's actual IDs and spare-account identity, retain the owner/auth/permissions flags above and set:

```cmd
set "PILOT_PAIRING_APPROVED="
set "PILOT_LIVE_APPROVED=true"
set "WHATSAPP_ENABLE_LIVE=true"
set "PILOT_EXPECTED_ACCOUNT_JID=REPLACE_WITH_VERIFIED_SPARE_ACCOUNT_JID"
npm run pilot:live
```

The placeholder is intentionally invalid. Never share the actual account identifier publicly. Configure only the consenting test group in ignored `data/pilot/groups.json`, using the verified leader/admin JIDs, `Africa/Khartoum` and `mentions: "none"`. The live command checks the connected account's phone or LID identity before enabling incoming processing or outgoing delivery. If the session needs a new QR or the account differs, it stops the connection; it does not silently pair another account. Starting this command enables automatic previews, feedback and reminders, so permission must cover those sends too. Existing pilot queued messages may be delivered on startup—review them before approval.

When finished, Ctrl+C and close the CMD window to discard approval variables. Persistent sessions remain in the external folder. Neither command intentionally calls logout or deletes credentials. Offline tests verify the safeguards; real QR pairing, persistence on the spare account, identity mapping and message delivery remain untested.

## Saved QR session validation and private group preparation

The owner subsequently confirmed the intended spare account's linked device, and the pairing terminal reported a connected status. Authentication was saved outside Git, reloaded offline, and the pairing-only process was gracefully stopped. Actual reconnect acceptance and group message delivery have not been retested.

Installed Baileys `7.0.0-rc14` initializes `registered=false`. Its QR success handler writes `me`, `account` and identity data without changing that flag; its login handshake checks `creds.me`. The live preflight now reads `creds.json` with Baileys' BufferJSON reviver without calling the auth initializer or saving anything. It requires valid matching phone/LID identity, complete consistent key pairs, signed prekey, registration ID, pairing secret, and signed account/device identity. It verifies signatures using the already-installed `whatsapp-rust-bridge@0.5.4`, now explicitly pinned as a direct dependency. The SDK's Curve.verify wrapper discards a false result from its underlying verifier, so it is not used for validation here. No SDK files are modified.

Malformed JSON, incomplete or fresh unpaired credentials, wrong account, broken keys and signatures are rejected even if `registered=true`. A complete signed QR session with `registered=false` is accepted. This checks local integrity and pairing evidence; it cannot establish the server's current acceptance, detect every corrupt auxiliary Signal file, or prove that a locally supplied signing identity is trusted by WhatsApp. Connected-account checks and separate live authorization remain mandatory.

No new connection is needed for the guard fix. Do not run either pilot command to discover group IDs: pairing mode deliberately has no discovery, while live mode enables automatic messages.

For the next separately authorized metadata step:

1. Have the private test group's owner confirm its name and consenting participants. Keep the university groups excluded.
2. If no verified group JID is already available, obtain that specific group's invite link privately from its owner and keep it locally in ignored storage. An invite link contains an access token: do not paste it into public reports or commit it. It is not itself the group JID.
3. After separate permission for a metadata-only connection, query only that invite's metadata to identify its group JID; do not accept the invitation, enumerate all groups, or read chat history. Stop if the result does not match the intended group or the spare account is not already a member.
4. Fetch participant metadata only for that verified group. Confirm the designated leader and each bot admin locally with the owner using their verified contact identities. Record only the required group JID and selected phone/LID mappings in ignored configuration. A display name alone is not proof, and WhatsApp group-admin status does not automatically grant bot approval permissions.
5. Keep the operational allowlist empty until the identities are verified. Then, with authorization, configure exactly one group, Africa/Khartoum, normal 24-hour reminders and `mentions: "none"`. Messages still need separate approval.

The stored authentication is not a directory of groups or contacts. The authentication fix did not retrieve group/participant IDs. The subsequent dedicated metadata command below supports that separately authorized step.

Authentication fix verification: **200 tests passed across 8 files**, TypeScript build passed, and Git whitespace checks passed. The existing real saved session passed the new validator in a read-only offline check; a before/after digest confirmed all authentication files unchanged (no digest or identity printed). No WhatsApp launcher was running, the allowlist remained empty, and the pilot database still had zero assignments or queued jobs/messages. Nothing was committed, pushed or deployed.

## Targeted metadata command

`npm run pilot:metadata` uses the existing signed session and is separate from pairing and live testing. It must never be run alongside another WhatsApp process using that session. There is no bot, database connection, incoming chat-message handler, reminder worker, outgoing delivery engine, or application-send API in this command. It uses the pinned SDK's base socket, bypassing its chat/group/community layers; the normal group layer can automatically enumerate all participating groups on dirty notifications. Base-socket re-pairing handlers are removed. A QR request, wrong account, disconnection, invalid target or timeout fails closed, closes the connection and preserves auth. Credential updates from legitimate connection maintenance are saved serially to the existing external directory. Authentication and metadata protocol traffic still occurs.

First open the Git-ignored local request file in Windows CMD:

```cmd
cd /d "E:\ASSING BOT REM"
notepad data\pilot\metadata-request.json
```

Fill it with the exact private group name and **either** its invite link **or** its exact group JID. Keep the other field empty. Set leader and admins to only the selected people's verified international phone numbers including `+`, or their already known phone/LID JIDs. Example values below are fictional; replace them locally. Do not paste your real values into a chat or report.

```json
{
  "expectedGroupName": "YOUR EXACT PRIVATE GROUP NAME",
  "groupJid": "",
  "inviteLink": "https://chat.whatsapp.com/YOUR_PRIVATE_INVITE_TOKEN",
  "leader": "+249900000001",
  "admins": ["+249900000002"]
}
```

A group name alone cannot be searched without enumerating groups, which is prohibited here. The invite is queried for its ID and name only; the command never accepts it or joins a group. The returned name must match the locally supplied expected name. Then it queries only that exact group. The spare account and every selected role must already be a member. A name, ambiguous mapping or guess cannot grant permissions. Membership metadata can contain the target group's whole roster because that is how the server answers its metadata API: the command transiently checks membership and selected matches, retaining no identifiers for unselected members. It never requests other groups, group descriptions, contacts lists or chat history; any extra returned fields are ignored.

After owner consent, directory approval, permission checks and explicit metadata-only authorization, set these variables in a fresh CMD window:

```cmd
set "WHATSAPP_ENABLE_LIVE=false"
set "PILOT_LIVE_APPROVED=false"
set "DATABASE_PATH=data/pilot/pilot.sqlite"
set "GROUPS_CONFIG_PATH=data/pilot/groups.json"
set "WHATSAPP_AUTH_DIR=%LOCALAPPDATA%\AssignmentReminderBot\pilot-auth"
set "PILOT_OWNER_CONSENT=true"
set "PILOT_AUTH_DIR_APPROVED=true"
set "PILOT_AUTH_PERMISSIONS_CONFIRMED=true"
set "PILOT_METADATA_APPROVED=true"
npm run pilot:metadata
```

The command prints only verification status and selected-admin count, never a phone number, group JID, invite, QR or credential. It saves the exact JID, only selected identity mappings, the expected account and **proposed** single-group settings into ignored `data/pilot/metadata-result.json`, then stops gracefully. `data/pilot/groups.json` remains `[]`; both mention modes remain disabled. An existing result is not overwritten: review it before any deliberate retry. Keep both input and result local; remove the invite from the request yourself when it is no longer needed. Do not share these files.

The proposed configuration is not operational authorization. After a privacy-safe review and separate configuration approval, the selected group can be copied to the operational allowlist. Starting `pilot:live` and sending automatic or manual messages still require separate explicit approval. A failed or incomplete metadata attempt must never be reported as a verified group.

Metadata implementation validation: **231 tests passed across 9 files**, TypeScript build and Git whitespace checks passed. Tests cover targeted invite/JID queries, selected identities, membership/name mismatches, missing approvals, disabled messaging, no chat listeners or delivery workers, re-pairing rejection, timeout, cancellation, disconnects and auth-save failure. Actual metadata identification remains pending valid local input; offline tests do not verify a real group.

## Authorized one-shot send and offline configuration

The metadata-only lookup subsequently succeeded for the local target: one private group, the selected leader and one admin were verified, including phone/LID mappings. The spare account was confirmed as a member. The connection stopped and saved authentication remained valid. No identifiers are included in this documentation.

The operator separately authorized exactly one message, `online now`, before configuration. `npm run pilot:one-shot` requires `PILOT_ONESHOT_APPROVED=true`, live messaging disabled, an empty allowlist, a verified local metadata result and the matching existing session. It constructs only Baileys' send layer, omitting the message-receive layer and its retry handlers. Automatic initialization, presence/group dirty-bit hooks, history and re-pairing are disabled. Its application send is restricted to the verified group, exact text and a single generated message ID. No mentions, quotes, reactions, invitations, bot, scheduler or delivery worker is used. SDK encryption may query the destination group's participants/devices as needed to encrypt that group message. Library console output is suppressed during sending because libsignal can otherwise log private session objects.

A durable exclusive intent in ignored `data/pilot/one-shot-online-now.json` prevents repeated runs, including after a crash, timeout or uncertain result. Do not remove or reset this record to retry. The command requires a matching WhatsApp server message acknowledgment as well as a matching send result; a resolved SDK call alone is insufficient. A missing acknowledgment is uncertain, even if the message appears on a phone. There is no automatic retry or reconnection. The connection closes and credentials are retained. Server acceptance does not prove recipient delivery/read status.

Only after server-acknowledged success, `npm run pilot:configure` with `PILOT_CONFIG_APPROVED=true` applies the verified single group and selected permissions to ignored pilot configuration and its isolated database, entirely offline. It refuses a failed/uncertain one-shot record and refuses any existing assignments/reminder jobs/outgoing messages. It does not open WhatsApp or enable live messaging. The original pilot preflight now delegates to tracked checks that accept either an empty prepared pilot or the exact verified single-group configuration with matching SQLite permissions, no assignments/queues and disabled mentions.

To verify the prepared/configured pilot offline in Windows CMD:

```cmd
cd /d "E:\ASSING BOT REM"
set "WHATSAPP_ENABLE_LIVE=false"
set "DATABASE_PATH=data/pilot/pilot.sqlite"
set "GROUPS_CONFIG_PATH=data/pilot/groups.json"
npm run pilot:check
node --env-file=.env.pilot data/pilot/preflight.mjs
```

This is a pre-assignment readiness check, not a monitoring command for a pilot that already has assignments. Both mention modes remain disabled and `pilot:live` must not be started without separate permission. Future sending authorization is not implied by the one-shot test or the single-group configuration approval.

### Completed one-message test and configuration

With explicit authorization, exactly one application send of the text `online now` was attempted to the verified private group. A matching server acknowledgment and matching send result were received. The connection closed gracefully; no retry occurred. This confirms server acceptance, not recipient delivery, notifications or read status. The exclusive one-shot record is preserved and blocks another execution.

After that success, the verified single group, selected leader and one admin were applied to ignored `data/pilot/groups.json` and the isolated pilot SQLite database. Phone/LID mappings remain only in the ignored metadata result. Configuration/preflight checks confirm matching permissions, Africa/Khartoum, normal 24-hour reminders, `mentions: "none"`, zero assignments, zero reminder jobs, zero outgoing queued messages and database integrity OK. `WHATSAPP_ENABLE_LIVE=false` is preserved. Authentication validated offline after sending; no logout/deletion, live assignment processing, delivery workers or further messages occurred. Zero WhatsApp launcher processes remained running.

Validation: **242 tests passed across 10 files**, TypeScript build and Git whitespace checks passed. No commit, push or deployment was performed. The pilot is prepared for a separately authorized first controlled assignment test; actual leader detection, quoted admin approval and registration/success delivery on WhatsApp remain to be verified. Do not start `pilot:live` until that permission is granted and its explicit account/environment requirements are supplied.

## Bounded first assignment and five-minute reminder test

The operator separately authorized one assignment preview, one successful registration response, one optional `!list` response and exactly one pilot-only reminder five minutes after admin approval. For this test only, `npm run pilot:live` dispatches to the bounded controller when `PILOT_CONTROLLED_TEST=true` and `PILOT_REMINDER_TEST=true`. Standard live operation is not used. The persistent `.env.pilot` live flag stays false; approval/live variables exist only in the supervised process environment.

The controller requires the exact verified group and selected phone/LID mappings, an empty pilot assignment/outgoing store and no previous controlled run. Incoming network envelopes are gated to the configured group before SDK decryption; private chats, other groups and offline/history messages are dropped. Automatic SDK group enumeration, initialization, incoming notification/call processing, retry receipts and re-pairing handlers are disabled. There is no reconnection in this test. Library console output is suppressed except fixed operator status messages.

The earlier launcher admitted only one complete SUST Moodle assignment more than 24 hours ahead; this restriction has been replaced by the correction workflow described below. The configured admin must reply `نعم` to its actual preview. Unknown/forged quotes, other senders, new announcements and repeated approvals remain ignored. Current-preview admin edits are now admitted as described below; delete/help remain outside this bounded test. Only one `!list` from a selected test participant is admitted after registration. Selected identities may use verified LID aliases without guessing or granting permissions to names.

A pilot-only SQLite send ledger reserves each allowed message category before attempting delivery. Preview, success, list and test reminder each have a one-send budget and require a matching WhatsApp server acknowledgment. Missing acknowledgment or failure is terminal: the durable outgoing row is marked failed, no automated retry occurs, and the test stops. Server acceptance does not establish recipient delivery/read status. Persistent pilot test tables prevent a silent restart of this first test after a crash or completion.

After approval, the exact reminder time is displayed in the visible terminal **before** inserting a single offset-0 job due five minutes after registration. Only the isolated pilot database receives this override; production 24-hour planning logic and group settings remain unchanged. Normal positive-offset jobs remain unchanged; the bounded controller targets only the explicit test job and does not run the general reminder scheduler. A one-second bounded outgoing-delivery loop handles allowed responses; the existing reminder pipeline is invoked for the single pilot job when due. No normal continuous reminder scheduler is started.

The process stops automatically after the reminder is sent/failed, on disconnect, on Ctrl+C, or after a 25-minute safety limit. Shutdown preserves authentication, disables the temporary override and cancels only the temporary unsent test job. The assignment and delivery records remain available for review. A later test requires separate authorization and a deliberate new test scope rather than resetting this run silently.

Manual assignment format (update to a future date before use):

```text
المادة: شبكات
اسم التكليف: واجب تجريبي Stage 4
الموعد النهائي: 2026-10-20 18:00
التسليم: SUST Moodle
```

The designated leader is also an authorized admin in this pilot, so that account can send the announcement and then reply directly to the bot preview. The spare bot account must not be used to send the announcement. Before the operator displays readiness, verify an authenticated connection, listener-active status, a fresh outgoing-loop heartbeat, the exact verified group/roles and disabled mentions. After readiness, the operator waits for the human announcement rather than generating it.


## Offline validation fix and correction workflow

The current controller accepts one authorized leader announcement containing one or more assignments. Missing subject, title, destination, or ambiguous deadline produces a numbered correction preview rather than silent rejection. Nothing is guessed. Only valid future deadlines allow final registration; optional unknown subject/title/destination remain explicitly unspecified after admin consent.

Reply directly to the latest preview using `!edit 1 course=Networks`, `!edit 1 name=Worksheet`, `!edit 1 deadline=2027-05-20 18:00`, `!edit 1 submissionMethod=email`, or `!edit 1 destination=teacher@example.test`. Use the actual assignment number and a future deadline in Africa/Khartoum. Each edit produces a replacement preview; reply to that newest preview with `yes`. Older previews cannot approve. Multiple assignments may use different Moodle, email, and custom destinations.

The pilot still rejects quoted leader announcements, unrelated chats/groups, unknown senders, forged quote authors and unrelated confirmations. Production parsing is separate from optional pilot assignment-count/destination limits. Diagnostic events contain only fixed codes and integer counts; no message text or WhatsApp identities are logged. An outgoing acknowledgment means the adapter returned successfully; in the controlled live socket this additionally requires a matching server acknowledgment, which does not prove recipient delivery.

The five-minute override is off by default. Offline tests explicitly select `scope: offline-test` and advance a deterministic clock; they never connect WhatsApp. A future approved live test additionally requires `PILOT_CORRECTIONS_APPROVED=true` to authorize replacement previews/feedback, alongside the existing test approvals. Preview and feedback budgets are configurable with `PILOT_MAX_PREVIEWS` and `PILOT_MAX_FEEDBACK` (defaults 32 and 8); optional `PILOT_MAX_ASSIGNMENTS` limits count without requiring complete fields. Do not set these approval variables or run the launcher during offline validation.

A separately approved override creates one persistent job exactly five minutes after approval for the first registered assignment, without altering its actual deadline or normal 72/24/2-hour schedules. Only that job can be processed by the bounded reminder worker. State and schedule are committed together. Offline restart tests also cover recovery between registration and scheduling. Uncertain sends remain terminal and require review, never automatic resend.

Repeat offline checks in Windows CMD:

```cmd
cd /d "E:\ASSING BOT REM"
set "WHATSAPP_ENABLE_LIVE=false"
npm test
npm run build
npm run demo:reminders
npm audit
git diff --check
```

The exact original announcement is read from ignored `data/pilot/original-announcement.txt` without editing it. That regression runs locally and skips on machines without the private fixture; committed synthetic cases remain portable. Tests use temporary SQLite databases and mocks. Existing pilot data, external authentication, allowlist and mention settings are preserved.

Before another live test, obtain fresh sending approval covering correction previews, feedback, success and one reminder. Review the previous persistent controlled-run record: the launcher deliberately refuses an existing run and never resets it. Offline controller resume is tested for the same policy with unambiguous accepted sends; the CLI does not automatically resume or migrate the earlier live run. A separately approved new isolated run or reviewed resume preparation is required. Do not delete the existing pilot database or silently reset its ledger. See [validation review](validation-fix.md) for results and changed files.

## Approved preparation before the next live test

Blank lines between fields no longer split a single assignment. Repeated subject/title headers and numbered items still separate genuine assignments. The exact Computer Networks pilot announcement now yields one draft, with its explicit Arabic deadline resolved to **2026-10-20 23:59 Africa/Khartoum** (21:59 UTC). Supported Arabic calendar dates require a full day/month/year, hour/minute and explicit morning/evening qualifier; invalid or competing dates still require admin correction. ISO dates retain their existing behavior.

Only the bounded pilot's selected five-minute reminder receives the label ` تذكير تجريبي — اختبار البوت`. The label is appended at send time; production reminders and the assignment's real deadline remain unchanged. The existing launcher uses real current timestamps and a one-second tick, not a mocked clock. The exact expected delivery time is displayed before the pilot schedule is inserted after approval.

With explicit operator approval and no bot process running, the previous empty waiting record was copied verbatim into `pilot_test_run_archive` in the existing ignored database, then only its active marker was removed in one transaction. All other database tables, authentication files and pilot configuration were verified unchanged; integrity and offline session validation passed. The archive helper refuses runs containing assignments, announcements, drafts, delivery records or reminder jobs. It is an offline operator operation and is never invoked automatically by the launcher.

No WhatsApp connection or messages were started for this preparation. Persistent live access and both mention modes remain disabled. Fresh approval is required before launching the supervised live test.

## Incoming diagnostic instrumentation (offline validated)

Validation: **297 tests passed across 13 files**, TypeScript build and Git whitespace checks passed. Sixteen new tests use a mocked Baileys factory and temporary SQLite databases; no real socket is created. The currently running pilot was not restarted or patched, and its database/authentication were not modified by this work.

Counters use only `{code, count}`. Raw transport entry emits `transport_message_received` before routing, then `transport_route_rejected` or `raw_group_message`; malformed envelopes emit `transport_key_invalid`. Rejected routes never have their bodies inspected. The aggregate route-rejection count contains no destination, participant, message type or chat metadata. Offline envelopes still emit `offline_message_rejected` and never reach the SDK handler. `sdk_message_handlers`, `sdk_handler_missing` and `sdk_handler_forwarded` distinguish registration/forwarding from SDK event emission; failures emit only `receive_failed`, never an exception payload.

`upsert_received` and `upsert_notify`/`upsert_append`/`upsert_other` are recorded at controller entry before its serial queue. The controller still processes only `notify`; `append` remains rejected regardless of timestamp. `message_update_received` and `history_event_received` count alternative SDK event kinds without examining their payloads. `listener_registered` records launcher listener registration and `pending_notifications_ready` records the SDK readiness event.

`pilot_group_matched`, `message_key_invalid`, `self_message_rejected`, `sender_resolved`/`sender_unresolved`/`sender_conflict`, `pilot_leader_matched`/`pilot_leader_rejected` and `pilot_message_ignored` explain the pilot gate. `pilot_parser_invoked` counts the preliminary extraction pass. The adapter separately emits `adapter_upsert_notify`/`adapter_upsert_append`/`adapter_upsert_other`, `adapter_disconnected`, `group_matched`/`group_rejected` and leader codes; `parser_invoked` marks business-parser entry. Pilot and adapter stage codes are distinct because admitted messages pass through both stages.

Timestamp codes are only `timestamp_missing`, `timestamp_invalid`, `timestamp_before_start` and `timestamp_since_start`. SDK timestamps are seconds. These codes are observational; they do not accept historical events or change existing notify admission rules. Existing `draft_created`, `preview_queued`, `outgoing_attempted`, `outgoing_acknowledged` and `outgoing_failed` complete the trace. Acknowledgment semantics remain unchanged.

Source changes do not instrument an already running Node process. A graceful stop and separately approved restart are needed before a new manually sent test can produce these counters. Preserve the prior run and review the launcher guard before restarting; never reset records or replay messages automatically. These offline tests do not establish why the earlier live announcement was absent. Keep the 73 startup history messages ignored and retain all authorization checks.

### Diagnostic restart preparation

The operator subsequently authorized archiving the gracefully stopped empty run. The helper now also permits `stopped` records only when connection, listener, worker and override flags are all explicitly false. It still refuses any assignment, draft, delivery or reminder activity. Within its transaction it verifies the inserted archive matches the original state before removing the exact active marker; a verification mismatch rolls everything back.

Preparation passed **303 tests**, the TypeScript build and offline pilot preflight. All diagnostic stages were verified in compiled JavaScript. The latest stopped record was archived verbatim, both earlier run records remain in history, and no active marker remains. Every other database table, saved authentication, protected pilot files, prior logs and existing backups was verified unchanged. A new uniquely named preservation directory contains the pre-operation database/WAL/SHM files where present and an additional consistent SQLite backup; no existing backup was overwritten.

The verified single-group permissions and selected phone/LID aliases pass offline checks. Messaging and mentions remain disabled; there are no assignments or queued messages/jobs. Nothing was connected or started. A separately approved restart must use a fresh diagnostic log file rather than overwrite the earlier exclusive log, and must never replay prior announcements automatically.

### Receive-readiness correction

The subsequent offline [installed-SDK receive review](incoming-receive-review.md) found that the bounded pilot removed SDK lifecycle listeners and treated connection open as sufficient readiness. Lifecycle hooks are now preserved while group/history gates and the enumeration restriction remain. Processing waits for pending-notification completion, actual open WebSocket, verified account, the original active transport and registered raw/upsert handlers, and an unbuffered SDK event queue. New wire/frame and SDK warning/error counters expose failures before `CB:message` without printing payloads. **316 tests and the TypeScript build passed.** The actual missing-message root cause remains unproven; no connection or restart was attempted for these corrections.
