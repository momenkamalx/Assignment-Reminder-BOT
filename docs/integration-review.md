# Stages 1–3 integration review and Stage 4 readiness

Reviewed on 2026-10-13. Stage 4 was not started. No real account was connected, no live messages were sent, no cloud deployment was performed, and no commit or push was created for this review. The existing user changes to AGENTS.md were not edited or included.

## Results

The baseline had 126 passing tests. The completed review has **139 passing tests across 5 test files**, including 13 new end-to-end cases. `npm run build` passes. `npm run demo:reminders` passes and prints two mock reminders, respecting the updated deadline and cancellation with no duplicate delivery on repeated ticks.

The new harness in `tests/end-to-end.test.ts` runs the real WhatsAppRuntime → BaileysAdapter → Bot → SQLite → ReminderWorker → BaileysAdapter path. Socket factories, event emitters, sends and group metadata are mocked. SQLite uses temporary on-disk databases with migrations and separate connections, then removes them after each test. Message timestamps and the business clock are deterministic. Baileys' actual local message serializer generates outgoing quoted-message and mention metadata; URL previews and uploads are disabled. No real socket factory or pairing helper is invoked.

| Requested scenario | Result and evidence |
| --- | --- |
| Three Sudanese Arabic assignments | All fields independently verified against the fixture: البرمجة/الدوال/SUST Moodle, الفيزياء/تقرير المعمل/email, الرياضيات/المصفوفات/custom link, each with its own deadline. Student announcements ignored. |
| Draft correction and registration | Numbered preview quotes the original leader ID. Correcting assignment 2 invalidates the old preview. Exact-message admin `نعم` saves all three and sends success. Unrelated, unauthorized and forged-author replies do not register anything. |
| Competing approvals and replay | Two independent bot/runtime and SQLite connections approve concurrently; exactly one registration succeeds, all sibling confirmations are invalidated, and replay of the same original message ID creates no additional assignments or jobs. |
| 24-hour reminders | Deterministic clock reaches each corrected deadline minus 24 hours. Every delivered message contains the right subject, name, local/UTC deadline and submission destination, routed to the correct group. |
| Optional 72-hour and 2-hour offsets | All nine offsets for the three assignments are delivered once under competing workers. |
| Leader extension and cancellation | A non-admin leader's explicit extension proposal waits for an admin's approval, cancels the old unsent schedule, and creates the new schedule. Confirmed cancellation suppresses all future reminders for the cancelled assignment. |
| Disconnection and restart | Fake socket closes during reminder delivery. Pending state and retry time survive reopening SQLite and restarting bot/runtime; recovery uses the same outgoing message ID. |
| Downtime | Multiple overdue offsets coalesce to the latest eligible reminder; overdue reminders at/after the deadline expire. |
| Database and group isolation | Reopened database retains assignments, drafts and prompts. Group-specific roles, schedules and destinations remain separate. Private chats, statuses and unlisted groups are rejected. |
| Africa/Khartoum | Arabic dates are normalized to UTC; local deadline formatting uses the correct Khartoum offset. The existing suite also covers DST transitions in another timezone. |
| Missing deadlines and late registration | Missing deadline blocks the entire batch until corrected. Registration consent is separate from immediate-reminder consent, which remains valid across restart and cannot be approved by an unrelated student or another group's admin. |
| Mentions | Default reminder output has no individual/native mention metadata or member lookup. Opt-in tests verify `nonJidMentions=1` for native mentionAll and `mentionedJid` for the authorized group's individual roster through the actual SDK serializer. |

## Failures found and resolved

1. **Leader deadline extensions were not supported.** They could be parsed as a new assignment announcement. The bot now recognizes an explicit extension referencing one saved assignment ID, validates one later future deadline, and queues the existing admin-confirmed update workflow. Missing/ambiguous IDs and times require correction rather than guessed matches. A non-admin leader cannot approve their own proposal. Supported example: `يا شباب تم تمديد تسليم التكليف #١ لحدي ٢٠٢٧-٠٥-٢٤ ١٨:٠٠`.
2. **Concurrent edit/approval could resurrect a pending preview.** While an edited preview was awaiting transport delivery, another admin could approve the original through a different connection. The late preview then created a pending confirmation for an already approved announcement. A single conditional SQLite insert now admits confirmations only while the original announcement remains pending, and the editing admin is told that a late preview is no longer valid. A targeted end-to-end interleaving reproduces the race and verifies the approved snapshot is unchanged and no pending confirmation remains.

Initial integration runs also exposed test setup mistakes: the restart fixture omitted its optional settings from the authoritative group configuration, and a clock jump crossed an un-cancelled assignment's deadline before expecting its reminder. Those fixtures/timelines were corrected to match the documented configuration and expiry behavior. **No current test or required command fails.**

## Readiness assessment

**Offline integration: ready.** All requested mock scenarios pass. **Supervised spare-account pilot: conditionally ready** once you explicitly authorize it and prepare the prerequisites below. **Production deployment: not ready yet**, and Stage 4 remains untouched.

Before connecting the spare account, resolve these prerequisites:

- Give separate explicit permission to pair and send test messages. Keep `WHATSAPP_ENABLE_LIVE=false` until then.
- Prepare a dedicated consenting test group, verified group/leader/admin JIDs (including LID identities where needed), and the private allowlist file. Placeholder example IDs are not real configuration. Bot-authorized admins must be explicit; WhatsApp display names/group-admin titles do not automatically grant permission.
- Choose an authentication directory outside Git with access restricted to your user (NTFS permissions on Windows), and run one live process per account/auth directory. Keep account credentials, QR output, SQLite data and `.env` private.
- Use a separate pilot database or back up existing data before the first live migration; validate the proposed pilot dates and group timezone. Keep mentions set to `none`.

Live-only checks remain: QR pairing/session reload, actual phone↔LID identities and quoted-message authors, client rendering of quoted previews (including a key-only quote after restart), actual message delivery/reconnect behavior, server handling of stable IDs after a lost acknowledgement, and native/individual mention notifications and role restrictions. Mocks verify our decisions and metadata, not WhatsApp server/client guarantees.

Before production use, address or explicitly accept the documented delivery limits: original leader previews and registration-success replies still use direct sends rather than a durable outbox; incoming history batches are intentionally ignored, so announcements sent during an outage need a controlled replay; there is no end-to-end exactly-once guarantee after an uncertain network outcome. The mock transport's deduplication is a simulation, not proof that WhatsApp will deduplicate every retry. Extraction is rule based and requires explicit unambiguous dates and recognizable assignment boundaries.

Stage 4 also needs its own implementation and validation: service startup/shutdown and environment handling, private persistent paths, SQLite-safe backup and restore testing, operational monitoring and an approved Oracle deployment plan. No hosting capacity or account eligibility has been verified here.

## Reproduce safely

```powershell
npm test
npm run build
npm run demo:reminders
# Optional: only the new integration suite
npm test -- tests/end-to-end.test.ts
```

Any future commit needs your explicit permission and exact commit message. Pushing requires separate permission.
