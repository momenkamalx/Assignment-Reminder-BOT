# Stage 2: Baileys integration

No real account was paired during development. All integration tests run against fake event emitters and fake send functions. A separate persistence test exercises Baileys' local authentication-file helper without creating a socket. Baileys is pinned to `7.0.0-rc14`; this is a release candidate and future upgrades need regression testing.

## Safe testing now

```powershell
npm install
npm test
npm run build
npm run demo
```

The demo remains the Stage 1 mock. To run only the Baileys tests:

```powershell
npm test -- tests/whatsapp.test.ts
```

To verify the real entry point refuses to connect, explicitly keep it disabled:

```powershell
$env:WHATSAPP_ENABLE_LIVE = 'false'
npm run whatsapp
```

It prints `Live WhatsApp is disabled` and exits without loading authentication or opening a socket. The script reads `.env` if it exists; an explicitly set shell variable takes precedence. Do not change the live flag or scan a QR during offline testing.

## Configuration

`config/groups.example.json` is an example with fictional IDs. Copy it to ignored `config/groups.json` when preparing your own configuration. The file is the complete, explicit group allowlist for each run. Removing a group from it disables both incoming processing and outgoing sends on restart, while preserving historical SQLite data. Changes require a restart; no chat message can alter authorization.

Each entry needs:

- The exact group JID, such as `120363…@g.us`. A display name or invite URL is not an identity.
- A leader JID, such as `249…@s.whatsapp.net`, or an explicitly known `…@lid` identity.
- A nonempty list of bot-authorized admin JIDs. WhatsApp group admins are not automatically granted bot permission, and a leader needs an explicit admin entry to approve.
- An optional IANA timezone, defaulting to Africa/Khartoum.

Use identities obtained through a trusted group owner or, after separate authorization for a future supervised test, verified WhatsApp/Baileys metadata. This stage deliberately provides no automatic group discovery or permission grants. Device suffixes are normalized. A Baileys message key's primary and alternate phone/LID identities can match configured identities; conflicting configured identities cause the message to be discarded. Display names and forwarded text are never used for permission checks. When no alternate phone mapping is available, configure the verified LID rather than guessing it.

Private chats, statuses, broadcasts, newsletters, unlisted groups, outgoing echoes, missing sender keys, media and history batches are ignored. Unapproved students cannot create assignments or approve/edit/reject drafts. Group members can use `!list` and `!help`. Only live `notify` text messages in authorized groups reach the bot. An approval/edit/rejection quote must identify the bot as its author, refer to the same group, and match a pending preview ID; the existing business logic verifies the configured admin too.

## Future supervised pairing (not performed now)

After you separately authorize a real test, populate the private group configuration, use a dedicated consenting test group and account, and set `WHATSAPP_ENABLE_LIVE=true`. Starting `npm run whatsapp` then opens the socket and displays the QR in the terminal; scan it using WhatsApp Linked Devices. Once paired, messages can be sent to the authorized test groups, so this is **not** an offline test. Stop with Ctrl+C.

Authentication defaults to your user home under `.assignment-reminder-bot/auth`, outside this repository. `WHATSAPP_AUTH_DIR` can specify another absolute directory outside the project. An in-project path is rejected. Credentials and encryption/session keys are persistent and secret; do not share them or QR output. The code requests restricted POSIX permissions; on Windows restrict the folder's NTFS access to your user account. Never commit or upload that directory. Run only one live process per authentication directory. Baileys' multi-file auth helper is suitable for this prototype, not a concurrent credential storage service.

Credential updates are serialized and flushed before restarting after pairing. Transient disconnects and socket-creation failures use capped exponential reconnect delays. Logged-out, replaced, invalid-session, forbidden and incompatible-session errors stop automatic reconnection for operator attention. Existing credentials are never automatically deleted. Shutdown cancels timers, removes listeners and flushes queued credential updates. If saving authentication fails, the integration stops to avoid running with unsaved session state.

## Data and limits

Messages are not logged. Runtime errors log fixed event names without raw exceptions, message content or credentials. Baileys' own logger is silent. History syncing is disabled and no media is downloaded. Routing checks run before inspecting unapproved message bodies. This prevents application processing of those messages; the WhatsApp socket necessarily still receives protocol traffic.

Migration 2 stores original announcement message keys (group, message ID and participant metadata), not message text, so draft edits can still quote their original announcement after a restart. Text used for immediate quoting is retained only during handling and then released. After restart, the quoted key is preserved but the original text excerpt is unavailable. Pending drafts and deduplication remain in the existing SQLite workflow.

Stage 3 adds reminders, confirmed changes/cancellations and opt-in mentions; see [the Stage 3 guide](stage-3.md). The [outgoing-reliability update](outgoing-reliability.md) adds durable preview/success/feedback delivery and shared bounded retries. Deployment remains pending. Offline tests cannot prove real-device interoperability; a supervised account test remains pending.

Baileys is unofficial WhatsApp automation and may risk account restrictions; use it only with group consent and respect WhatsApp rules. Upstream references: [Baileys example](https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts), [project README](https://github.com/WhiskeySockets/Baileys/blob/master/README.md), and the installed package's TypeScript definitions.
