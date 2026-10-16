# One authorized synchronization-only connection

Completed on 2026-10-16 using the existing saved spare account. This is a protocol diagnostic, not an assignment or reminder test.

## Scope and preparation

No previous pilot process was running. The previous empty stopped marker was copied verbatim into the run archive and verified before removal. Earlier history and other database records were unchanged. A fresh uniquely named preservation directory contains a consistent SQLite backup and copies of existing database/WAL/SHM/log files; nothing was overwritten.

The dedicated `npm run pilot:sync` command requires explicit sync approval, the existing verified single-group profile, disabled live application messaging, an expected paired account and a fresh exclusive run intent. It does not import or start a bot, assignment parser, confirmation workflow, outgoing queue worker or reminder scheduler. Its public application send methods reject all calls. Native SDK message, notification, receipt, credential and LID handlers remain intact. The group dirty/enumeration hook and re-pairing hooks remain disabled. History synchronization remains disabled. The SDK can perform normal scoped protocol delivery, while there is no application consumer for historical messages.

The logger classifies fixed SDK message constants in a pino hook before serialization, then drops every original argument. It never enables trace XML or records raw payloads, identifiers, credentials or keys. Counters mark protocol acknowledgment/receipt and native batch-request **attempts**, not remote acceptance of each individual write. No batch was manually requested and no offline flag was reinterpreted.

## Observed result

| Observation | Count/result |
| --- | --- |
| Account verified, socket opened | Yes |
| Wire payloads / decoded frames | 32 / 135 |
| Decoded message frames / raw callbacks | 97 / 97 |
| Authorized-group raw callbacks | 86 |
| Offline flag zero / other | 13 / 73 |
| Native offline preview frame/callback | 1 / 1 |
| Native batch-request attempt | 1 |
| Protocol acknowledgment attempts | 39 |
| Notification / receipt / message acknowledgment attempts | 7 / 19 / 13 |
| Native delivery-receipt attempts | 84 |
| Server offline-completion frame/callback | 1 / 1 |
| Pending flag changed false to true | Yes |
| Buffer observed released | Yes |
| SDK application event batches | 1 append batch; no application processing |
| Signal-key writes completed / failed | 101 / 0 |
| Credential saves completed / failed | 2 / 0 |
| Unexpected disconnections | 0 |

The SDK emitted three warnings: sync-disabled, missing-presence-name and one unclassified warning. It also emitted four unclassified errors. The older shared `sdk_warning_unclassified` category totals five because it currently includes unclassified errors as well as warnings; severity counters distinguish three warnings from four errors. No raw warning or error was retained, so the four errors must not be called decryption failures without further evidence. They did not prevent the observed completion marker or key-save success.

## Interpretation

The last confirmed successful stage is server pending-delivery completion: the decoded marker arrived, the native callback ran, the pending flag became true, buffering released and an append batch was emitted. This demonstrates that the saved session and server completion path can work. It does not establish fresh notify-message reception, assignment extraction, previews or recipient delivery.

Compared with the earlier bounded pilot, preserving native protocol processing coincided with successful completion without extra batches or forced flags. That strongly implicates the earlier suppression of SDK acknowledgment/receipt processing. The test changed a group of related protocol-handler restrictions together, so it does not isolate one particular missing ACK or prove that every future session will complete.

The smallest justified next correction is to preserve the proven native protocol handlers in the controlled pilot and enforce authorization/history restrictions at the application boundary, with offline tests proving append/history events cannot create drafts and foreign groups cannot reach application logic. The SDK's early `shouldIgnoreJid` gate must remain scoped; do not enable broad history synchronization or group enumeration. Classify the remaining SDK errors with fixed codes before relying on fresh-message delivery. Do not normalize offline-zero flags or manually continue batches based on this result.

## Shutdown and preservation

After the completion event the runner waited three seconds, gracefully ended its only socket, drained pending key/credential writes and exited successfully. The final snapshot has WebSocket closed, buffer inactive, pending completion observed and account verified. A status JSON and fresh sanitized log remain in ignored pilot storage. No logout, unlink, reconnect or second connection occurred.

Database integrity is OK. There are zero assignments, announcements, drafts, outgoing messages, reminder jobs and send-ledger entries; all four earlier run records remain archived and no active application marker exists. The saved session validates after normal SDK credential/key maintenance. Persistent live application messaging and all mentions remain disabled. Zero pilot processes remain.

Offline validation: **339 tests passed across 15 files**, build and whitespace checks passed. New code consists of sync-only socket/runtime/launcher modules, a sync permission/profile branch, a command entry and fixed diagnostic codes. Eight new mocked tests cover native handler preservation, application-send blocking, log redaction, key-write passthrough, pending transitions, bounded shutdown, cancellation and account mismatch. No commit, push or deployment was performed. Any next live connection requires separate explicit approval.

## Future runs: strict observation deadline

The runner now observes for at most **180 seconds from the actual WebSocket open event**, including any wait for the SDK's authenticated connection update. Repeated open events cannot reset or extend the deadline, and there is no configurable longer duration. An already-open socket starts the window immediately when attached. A separate 60-second connection timeout stops a socket that never opens.

An observed `receivedPendingNotifications: true` ends observation immediately; the historical three-second settling delay described above has been removed. If completion remains unobserved at the deadline, `sync_duration_elapsed` is recorded and shutdown begins automatically. `sync_connection_timeout` identifies failure to open, separately from unobserved synchronization. There is no retry or second connection.

Shutdown clears both deadline timers, the polling interval, the abort listener and the observer's WebSocket/SDK listeners. It captures final snapshots, closes the socket without logout and drains credential/key writes before returning. Safe persistence cleanup is awaited after observation ends; the three-minute limit is on observation, not forced termination of in-flight storage writes. Cleanup also runs when transport closure fails. Native SDK listeners remain untouched.

Offline validation after this change: **343 tests passed across 15 files**, TypeScript build and whitespace checks passed. Fake-time regressions cover the exact 180-second boundary, delayed transport opening, repeated open events, immediate completion at the boundary, no-open timeout and cleanup on closure errors. No live connection was made for this change.
