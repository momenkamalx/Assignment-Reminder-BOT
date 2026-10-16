# Offline review of missing live incoming messages

Reviewed the installed **@whiskeysockets/baileys 7.0.0-rc14** and the bounded controlled pilot. No WhatsApp connection, message, authentication write or pilot-database mutation was performed for this review.

## Confirmed observations

The last live diagnostic run recorded one SDK message handler and one application upsert registration. Its 84 startup message callbacks comprised 11 rejected routes and 73 authorized-group offline messages. Counters did not increase after the manually sent announcement. No upsert, draft, preview or send attempt was recorded. `pending_notifications_ready` was absent. These observations locate the observed failure before the normal matched-group SDK message pipeline, but do not establish why the fresh message never reached that callback.

The old READY checks were insufficient. `controlled-main.ts` started the controller and outgoing loop on `connection: open`, without checking pending-notification completion, actual WebSocket openness, live listener attachment or event-buffer state. The SDK emits open in `Socket/socket.js` on its successful-login path; that path catches initialization errors and can still emit open. It is not a receive-readiness guarantee.

`controlled-socket.ts` also removed all existing SDK connection, credential and LID listeners. In the installed `Socket/chats.js`, connection callbacks drive synchronization state, buffer/flush transitions and normal unavailable-presence protocol handling; credential callbacks support blocked app-state synchronization and LID callbacks store mappings. `Socket/messages-recv.js` also has connection cleanup callbacks. Removing these hooks was a concrete lifecycle defect. Restoring them is a correction, not proof that this alone caused the unseen live message.

## Installed SDK trace

- `Socket/socket.js`: `onMessageReceived` emits decoded `frame`, then specific callbacks and the generic callback for the node tag. Ordinary message nodes still emit `CB:message` even when a specific callback handles them. A synchronous exception earlier in dispatch could prevent later dispatch; no previous frame-level evidence exists to establish that happened.
- `Socket/socket.js`: `CB:ib,,offline` flushes initial buffering and emits `receivedPendingNotifications: true`. The pilot never recorded that event in the last diagnostic run. There is no evidence that pending synchronization completed.
- `Socket/messages-recv.js`: offline-envelope presence selects append; otherwise messages use notify. This classification is not a message-age comparison. SDK message handling performs decryption before application upserts, but raw pilot counters precede that handler.
- `Utils/event-buffer.js`: buffered upserts are delayed until flush. Its `process()` subscription and named event subscriptions coexist; process is not a consuming subscription. The bounded pilot does not use process. A real installed-buffer regression verifies both subscribers receive the event after flushing.
- `Socket/chats.js`: with history disabled, the pending-notification callback transitions online and schedules a flush. History remains disabled; the correction does not pass the 73 ignored offline messages to message processing.
- `Socket/groups.js`: automatic group enumeration is attached to the dirty hook. That low-level hook remains removed. Preserving lifecycle hooks does not restore enumeration, unrelated chat processing, automatic initialization queries or history collection.
- `Socket/Client/websocket.js`: `isOpen` checks the underlying WebSocket ready state. The new gate checks this actual value rather than the application heartbeat.

The bounded launcher constructs one socket and stops on close/QR rather than reconnecting or replacing it. It does not use the separate general reconnect runtime. There is no socket-replacement path explaining the previous failure. Actual transport and event-emitter ownership are now checked to guard future changes and accidental listener removal.

## Corrections and new evidence

SDK lifecycle listeners are preserved. The raw exact-group gate, offline rejection, notify-only processing, phone/LID authorization and quoted-confirmation checks remain intact. No old messages are acknowledged, replayed or processed by a new application path.

Readiness now requires all of: authenticated expected account, open connection and actual WebSocket, pending-notification completion, the original transport with the scoped raw callback still registered, at least one captured SDK message callback, the actual upsert listener still attached to its original emitter, and a non-buffering SDK event queue. Only then does the controller attach and its bounded outgoing loop start. Transport or listener loss after activation stops the pilot. Temporary buffering during ordinary processing is allowed and does not trigger forced flushes or acceptance of history.

The installed rc14 event-buffer `on()` returns its underlying EventEmitter. Listener verification uses that return value and fails closed if it cannot inspect registration. A regression uses the actual installed buffer to verify registration, removal and emitter replacement; it does not connect a socket. This SDK-version-specific assumption must be rechecked on upgrades.

New wire and decoded-frame counters distinguish encrypted payload arrival, decoded message/notification frames, and dispatch to the raw route. They record fixed codes/counts only, without reading identifiers or message bodies. SDK warning/error severity is counted while all serialized log payloads are discarded. A generic SDK error does not by itself prove decryption failure. Preserved SDK lifecycle hooks may perform normal account protocol maintenance in a future separately authorized connection; application sends remain bounded by the pilot.

## Unverified hypotheses

The server may not have completed pending delivery/activation, the connection may have carried only protocol traffic, or an earlier dispatch/SDK failure may have intervened. Raw offline messages and notifications are currently dropped before their SDK handlers, so normal SDK receipt/ack paths do not run for those nodes. Whether that contributes to the missing pending-completion marker cannot be established offline. No acknowledgment, history-filter relaxation, forced sync, automatic retry or unrelated notification processing was introduced on that hypothesis.

Decryption and application parsing cannot account for the absence of a fresh raw-handler counter along the ordinary message path. They could matter after a fresh message reaches that path, which the new counters can distinguish. The exact delivery root cause remains unproven.

## Validation and next gate

**316 tests passed across 13 files; TypeScript build passed.** Tests cover preserved SDK callbacks, all readiness prerequisites, actual buffer behavior, missing handlers, closed/replaced transports, removed/replaced upsert listeners, private payload suppression, scoped routing, ignored offline/append messages and duplicate protection. No live result is claimed.

One more separately authorized preview-only diagnostic connection is justified with the corrected readiness gate and lower-level counters. It must not advertise READY if pending sync or receive readiness is absent. The existing stopped run remains preserved and will require a separately approved archive before startup. Use a fresh log, one new manually sent announcement only after genuine readiness, and no admin approval or reminder test. Never replay the previous announcement automatically.
