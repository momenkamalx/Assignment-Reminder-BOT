# Pending-notification investigation — installed rc14

Offline review on 2026-10-16. No WhatsApp connection, real send, auth write, history replay, dependency upgrade or pilot database mutation was performed.

## Completion path and meaning

Searching the installed SDK finds one false emission and one true emission, both in `node_modules/@whiskeysockets/baileys/lib/Socket/socket.js`:

1. Startup emits `connection: connecting` with `receivedPendingNotifications: false`.
2. `CB:ib,,offline` reads the server's offline child, flushes the initial event buffer if applicable, then emits `receivedPendingNotifications: true`.

There is no separate true emission for login, resumed credentials, zero backlog, a buffer timeout, successful key persistence or history-disabled configuration. The completion flag is optional in individual connection updates; open does not imply true. No elapsed-time fallback proves server completion. The SDK's app-state state machine consumes the flag; app-state/history synchronization and pending delivery are related phases, not interchangeable proof of completion.

The server `offline_preview` handler sends one `offline_batch` request with count 100. The installed source contains no continuation loop there. The SDK's normal receive paths send protocol receipts or acknowledgments, including acknowledgment in notification handling's finally block. Server-side requirements for draining batches are not specified by this client code; absence of a required ack cannot be proven to be the cause of our stall solely by reading it.

## Our integration versus normal receive processing

The scoped raw gate drops messages from other routes and all truthy offline flags before the SDK message handler. It also removes the SDK notification/receipt/call handlers and the dirty hook. Consequently the discarded nodes do not follow normal SDK receipt/ack paths. This is a confirmed integration difference that can plausibly affect pending delivery; it is not a confirmed server-side causal chain. No ack, NACK, batch-continuation request or historical processing was added during this investigation.

The SDK and pilot both treat `offline="0"` as truthy. Our previous counters did not distinguish flag values, so we cannot know whether any of the 73 discarded messages carried zero. New scoped counters distinguish absent, zero, one and other values, while preserving the existing conservative rejection of all truthy flags. Reclassifying zero as live would require an independently reviewed privacy/history policy and consistent SDK behavior; it was not done.

The corrected pilot preserves the SDK's offline-completion hook and internal lifecycle listeners. Its connection callback is registered synchronously after socket construction, before asynchronous network initialization can finish. Connection updates are not bufferable events in this SDK. A normally dispatched completion marker should therefore reach the application's callback unless dispatch, a preceding callback or flush fails. No such failure was demonstrated in the saved run.

The SDK dispatches only the first child tag when generating `CB:ib,,CHILD` callback names. New frame-level observers count offline-preview/offline marker child tags anywhere in an ib node and separately count the named callbacks. This can distinguish a marker never observed from a marker whose dispatch/earlier handler did not complete. Observers do not read identifiers, body contents or raw attributes and do not trigger any protocol operation.

## What the last run establishes

The last snapshot had an open, verified, original socket; intact raw and upsert listeners; an unbuffered event queue; and no pending-completion event. Three SDK warnings were counted, but their categories were discarded by the older logger. Generic decoded-frame counts cannot retrospectively tell whether an offline-preview or completion marker arrived. The buffer becoming unbuffered is compatible with rc14's 30-second timeout, and is not evidence that the server queue completed.

| Interpretation | Evidence |
| --- | --- |
| Server pending delivery genuinely stalled | Plausible; not established. Dropped ack paths and one-shot batching warrant investigation. |
| Server completed, but its marker/event was absent or lost | Not excluded; old counters did not identify ib child tags or native completion callbacks. |
| Application falsely interpreted a healthy/open connection as completed | Earlier READY was incorrect; the current gate correctly keeps completion **unconfirmed**, rather than declaring failure or bypassing it. |

The absence of this event is not proof that credentials are invalid or that a resumed session cannot receive anything. Conversely, source code provides no guarantee that open plus timeout means a valid caught-up session. The gate therefore remains fail-closed.

## SDK warnings and auth persistence

The installed socket warns when `shouldSyncHistoryMessage` disables every history type, explaining that initial LID mappings may be unavailable. The source also has warnings for passive activation, digest validation, missing presence name, LID storage and transaction commits. The event-buffer timeout has its own warning. We cannot reliably assign the saved three warning counts to these messages after the fact.

The logger now maps only known SDK message constants/prefixes into fixed diagnostic codes: sync-disabled, buffer-timeout, activation, digest, prekey, presence, LID and key-commit categories, plus unclassified. Raw message strings, exception objects and serialized payloads are discarded. Frame and offline-preview/completion observers similarly emit codes/counts only. These diagnostics do not enable trace logs or alter synchronization behavior.

The real auth store is correctly wired to `useMultiFileAuthState`. Credential updates mutate the shared credentials and are serialized through `saveCreds`; Signal keys use the separate `keys.set` implementation, with per-file SDK mutexes and transaction-backed writes. They do not require a creds.update event to persist. Tests with a temporary synthetic SDK auth store demonstrate independent key and credential persistence. The actual saved session was never passed to this initializer during the investigation.

The SDK reader returns null for malformed or unreadable key files. The signed-session preflight does not prove integrity of every auxiliary Signal key. This is a limitation, not evidence of corruption in this session. No real key file was changed, deleted or repaired.

## Upstream comparison

[Issue 2810](https://github.com/WhiskeySockets/Baileys/issues/2810) reports a similar missing-marker symptom, truthy offline-zero classification, and a later report of incomplete batch draining. Those are reporter observations, not proof of our cause; its original environment was 6.7.24, whereas our rc14 buffer does have a timeout.

[Draft PR 2840](https://github.com/WhiskeySockets/Baileys/pull/2840) proposes changing offline-zero classification only. It does not fix batching or completion-marker delivery. The [release page](https://github.com/WhiskeySockets/Baileys/releases) still lists rc14 as latest when checked. No newer released fix for this exact stall was verified, and no dependency or SDK source was changed.

## Validation and next step

New regressions cover warning redaction/categories, raw-marker versus callback observation, conservative offline-zero rejection, real rc14 buffer timeout without a completion event, continued readiness refusal, synthetic Signal-key persistence without credential events, and null-on-corrupt synthetic keys. Existing authorization, group isolation, duplicate prevention and preview-only safeguards remain intact.

Final validation: **331 tests passed across 14 files, zero failures; TypeScript build and Git whitespace checks passed.** Integrity comparisons confirmed actual saved authentication, pilot SQLite database, pilot configuration/environment, diagnostic log and AGENTS.md unchanged during validation. No pilot processes are running.

Recommended next connection, only with separate authorization: synchronization-only observation with **no announcement or application send**. Compare preview frames/callbacks, completion frames/callbacks, offline-flag counts and sanitized warning categories. If those implicate ack suppression or batching, design and test the minimum protocol-only correction before enabling it. Do not request extra batches, acknowledge/replay history, force the flag true, expand history access, re-pair or alter keys on speculation. Another ordinary assignment test is not yet justified.
