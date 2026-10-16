# Persistent outgoing delivery and Stage 4 readiness

This update is offline only. No real account, live sends, deployment, commit or push was performed. No dependencies were added. This guide supersedes the earlier direct-send limitation for previews and success replies in the integration review.

## Durable intent and one delivery engine

Migration 4 adds `outgoing_messages` and preserves existing reminder jobs, stable IDs and legacy confirmation delivery state. New announcements atomically save their IDs, extracted drafts, stable preview IDs and outgoing previews before attempting transport delivery. A preview retry never creates another draft. Draft edits atomically invalidate older previews and persist the replacement before its network await.

Registration saves assignments, plans reminders, invalidates previews and queues one success reply in the same transaction. Rejection feedback and saved-change/immediate-reminder acknowledgements are also queued in their business transaction. Corrections, admin-required acknowledgements and command replies are persisted before attempting delivery. Existing late-registration requests and saved-change previews retain their durable reminder-job storage.

`ReminderWorker` services both tables through the same `DeliveryEngine`: one lease, retry, exhaustion and completion policy, with no second retry daemon. The bot uses its outgoing-only flush for responsive replies; the existing periodic worker resumes due replies and reminders after restart/reconnection. SQLite claims protect concurrent instances.

Outgoing states are `pending`, `sending`, `sent`, `failed`, `cancelled` and `expired`. Reminder jobs keep `leased` as their compatible sending state and now support `failed`. Claims use an ownership token and a renewable 60-second lease. Crash recovery keeps the outgoing ID. Temporary failures back off from 1 second, doubling to a 5-minute cap, with 8 attempts by default. Known-disconnected transports are not claimed and do not consume attempts. A disconnect during a send records a retry; reconnection honors its persisted next-attempt time.

Explicit permanent failures, quote-reference errors, selected transport rejections and ignored stable IDs stop automatic retries. Unknown errors are temporary subject to the limit. Completion and preview delivery flags are transactional. Logs use fixed reason categories and delivery IDs, not bodies, raw exceptions or credentials. `sent` means the adapter completed with the requested ID, not proof of delivery/read receipt from each device.

## Confirmation safety, expiry and privacy

Previews are linked to the correct group, announcement and active confirmation. Validity is checked before sending; approval, rejection or editing makes older requests ineligible. A late send completion cannot reactivate a confirmation. Already-started network operations cannot be recalled.

Previews expire after 7 days; stale approvals and retries cannot reopen them. Informational feedback expires after 24 hours to avoid old correction/command spam. Registration success remains eligible while at least one associated assignment is active and future-dated; after all are cancelled or past their deadlines it is cancelled without altering saved assignments.

Approval before any preview attempt is blocked. An exact authorized admin reply during a pending/sending retry may be accepted because an earlier attempt may have delivered despite a lost acknowledgement. Existing group, admin, bot quote-author and stanza-ID checks still apply. Permanently failed or expired previews cannot be approved without eligible recovery.

Required preview failure records `confirmations.delivery_error`, preserves the draft and exposes a failed delivery; nothing is silently registered. Failed correction feedback does not disable a valid preview. All control responses have no mass or individual mention metadata. Reminder mention defaults remain `none`.

Quotes persist only key metadata, not incoming chat text. A retry after restart can quote the original leader announcement or admin request. Immediate delivery may use the in-memory text excerpt; after restart the quote can be key-only with an empty excerpt, whose real-client rendering remains unverified. Outgoing message content necessarily includes extracted assignment/submission data, so the SQLite database must stay private.

## Inspect and recover failures

Configured admins in the affected group can use:

```text
!delivery
!retry MESSAGE_ID
```

Reports show response-state counts and failed response/reminder IDs, kinds, attempts and safe reasons, without dumping message bodies. Recovery resets the budget but preserves the ID and draft. It applies only to a failed, still-relevant message in that group; expired, obsolete, cancelled and completed requests cannot be revived. Unauthorized students and other groups' admins cannot recover it.

When WhatsApp is unavailable, use the private database locally:

```powershell
$env:DATABASE_PATH = 'data/bot.sqlite'
npm run delivery -- status
npm run delivery -- status GROUP_ID
npm run delivery -- retry GROUP_ID MESSAGE_ID
```

The CLI never imports/starts Baileys, even with a live flag set. It inspects/requeues only; a configured worker delivers later. Opening the selected database applies migrations, so select the correct path and back up before upgrading. Do not share database files or reports containing group/message identifiers.

## Offline validation

**160 tests pass across 6 files**, including 21 new temporary-SQLite/mock-event recovery cases. Required commands `npm test`, `npm run build`, `npm run demo:reminders` pass; `npm audit` reports 0 vulnerabilities.

Coverage includes disconnects before/during sends, crash leases, restart recovery, concurrent SQLite workers, temporary/permanent errors, exhaustion/manual recovery, transactional registration and change-ack rollback, three assignments, stable-ID duplicates, admin approval during an uncertain retry, rejected/expired/replaced previews, cancellation before delayed success, durable quote references, group/admin isolation, no-mention control output, migration preservation, private logging and local CLI recovery without a connection.

Existing tests now assert durable pending state instead of deleting drafts/rejecting handlers on send errors. Preview edits invalidate the old confirmation before sending. Fake send functions honor the requested stable ID. Mock transport deduplication is a simulation, not proof of WhatsApp behavior.

## Remaining limits and readiness

**Offline recovery is ready. A supervised spare-account pilot is conditional on explicit authorization and private configuration. Production deployment remains unvalidated; Stage 4 was not started.**

Before pairing, prepare a dedicated consenting group, verified group/leader/admin phone or LID identities, a private allowlist and auth directory outside Git, a separate or backed-up pilot database, and one live process per auth directory. Keep `WHATSAPP_ENABLE_LIVE=false` and mentions `none` until a pilot is authorized.

Live checks still needed: pairing/session compatibility, phone/LID quote identity, key-only quote rendering, actual transport rejection/disconnection behavior, notifications and handling of repeated stable IDs. Native/individual mention notifications remain untested.

There is **no end-to-end exactly-once guarantee**. A crash after WhatsApp accepts a message but before SQLite records completion is uncertain; recovery retries the same ID. If Baileys reports completion and a later server/network failure prevents recipient delivery, SQLite alone cannot detect it; this update has no recipient-receipt reconciliation. A long pause can outlast a lease, and network sends cannot be atomically cancelled with SQLite. A hung send relies on the adapter's timeout/disconnection handling while its lease is renewed; no application-level abort is introduced.

Incoming history batches remain ignored, so announcements never received/persisted during an outage may need controlled replay. A database failure before enqueue cannot create durable intent; handlers report it and business transactions roll back where applicable. Losses predating this migration cannot be reconstructed from unstored data.

Terminal records are retained for audit/deduplication; automated archival/retention is still an operational decision. Stage 4 must validate secure service operation, SQLite-safe backup/restore, queue-failure/pending-age monitoring and deployment configuration. Offline tests do not prove production WhatsApp behavior.
