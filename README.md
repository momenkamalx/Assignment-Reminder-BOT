# WhatsApp Assignment Reminder Bot — Stages 1, 2 and 3

A Node.js + TypeScript prototype using SQLite, a mock WhatsApp adapter, Vitest, an offline-tested Baileys integration, and persistent automatic reminders. No WhatsApp account was paired, no live messages were sent, and no paid API or cloud deployment was used. Live startup is disabled by default. See [Stage 2 setup](docs/stage-2.md) and [Stage 3 reminders and safe testing](docs/stage-3.md).

Before Stage 4, read the [end-to-end integration results and readiness assessment](docs/integration-review.md). Run `npm test -- tests/end-to-end.test.ts` to repeat the complete mocked-event and temporary-database workflow without pairing an account.

## Run locally

Install Node.js 24 or later. In PowerShell inside this folder:

```powershell
npm install
npm run build
npm test
npm run demo
npm run demo:reminders
```

The demo sends two mock leader announcements, prints their Arabic confirmation preview, simulates admin approval, and prints the upcoming assignments. It writes to `data/demo.sqlite`; repeating it creates new example announcements. No messages leave your computer. Use `npm run test:watch` while changing the code.

To experiment, change the announcement in `src/demo.ts`, or create a test using `Bot.handle({ id, groupId, senderId, text, replyTo })`. Configure authorized group IDs, leaders, admins, and timezones through `Store.configureGroup`. A leader is not automatically an approver: add them to the admin list if desired. The mock adapter's `sent` array contains the outgoing IDs needed for `replyTo`.

## Supported announcement format

Separate assignments with blank lines, numbered entries, or explicit course headers:

```text
المادة: البرمجة
عندنا واجب
اسم التكليف: تمارين الدوال
الوصف: حل الأسئلة
تسليم: 2027-05-20 18:00
SUST Moodle https://moodle.example.edu/task

Course: Physics
Assignment
Name: Lab report
Due: 2027-05-21 12:00
Email: lecturer@example.edu
```

English keywords assignment/deadline/project/due/exercise/exercises and Arabic واجب/تسليم/مشروع/تمرين/تمارين are recognized. Sudanese phrases such as `عندنا واجب تسليم بكرة` or `عندنا تمرين` create a draft requiring a corrected deadline. Arabic numerals are supported in both dates and numbered assignment entries (`١.`, `٢.`, `٣.`), including messages without blank lines. Unrecognized submission URLs are classified as custom links. Extraction is rule based: explicit labels extract course, name and description; absent fields remain unknown. This is not unrestricted natural-language understanding. Ordinary unstructured chat is filtered conservatively; keyword-rich conversations may still require an admin rejection.

Deadlines must contain exactly one `YYYY-MM-DD HH:mm` date and time per assignment. `Z` and `+HH:mm` offsets are accepted. Otherwise Africa/Khartoum is used (or the group's configured timezone); SQLite stores UTC. Relative dates, date-only values, invalid dates and multiple deadlines require correction. Past deadlines cannot be approved. Missing courses or names remain explicitly marked unknown and do not prevent approval.

## Confirmation and commands

The bot quotes the original leader message and asks `هل تريد تسجيل التكليفات؟`. Only configured admins replying to that specific preview in the same group can approve with `نعم`, `يس`, `yes`, or `y`; reject with `لا` or `no`.

Before approval, reply to the current preview with:

```text
!edit 1 deadline=2027-05-20 18:00
!edit 2 course=Physics
!edit 1 name=Worksheet 2
```

Supported fields: course, name, description, deadline, submissionMethod, destination. Each draft edit sends a new preview and invalidates earlier previews. Approve the newest preview. `!list` lists upcoming assignments for the current group; `!help` explains commands. Saved assignment edits use an unquoted `!edit ID FIELD=VALUE`, and cancellations use `!delete ID`; each queues a separate admin confirmation. See the Stage 3 guide for reminder approval, settings and recovery behavior.

## Storage and reliability

`src/database.ts` applies idempotent version-1 schema migration with a migration ledger. Groups, announcement IDs, pending drafts and assignments persist in SQLite. Foreign keys, unique constraints, `BEGIN IMMEDIATE` transactions and an in-process message queue prevent duplicate registration and partial approval. Approving or rejecting invalidates all confirmations tied to the announcement. Tests cover independent connections and restart recovery.

The regression fixture in `tests/fixtures/sudanese-announcement.ts` contains one Sudanese Arabic message with three separately numbered subjects, distinct deadlines, and SUST Moodle/email/custom-link destinations. Tests verify every extracted field, correct preview quoting, exact-message admin approval, missing-deadline correction, replay and competing-approval protection, rollback after the second assignment fails to save, and isolation when two groups share an original message ID. Nothing is registered until every draft has a valid future deadline.

Raw chat messages are not stored or logged. Only configured identities, announcement IDs and extracted assignment data are retained. Database files may contain personal identifiers and submission addresses; keep the data folder private. `.gitignore` excludes databases, `.env` and future authentication storage. `.env.example` documents configuration; the demo reads `DATABASE_PATH` from the process environment, not automatically from `.env` (Node's `--env-file` can load it). There are no WhatsApp credentials in Stage 1.

The adapter contract is separate from parsing and business logic. Stage 3 adds persistent jobs and retries for reminders, late-registration permission prompts and saved-assignment change previews. The original leader-announcement preview and registration success acknowledgement still use the Stage 1 direct-send path; an interrupted preview or lost success response requires a replay or `!list` check. External transport and SQLite writes cannot be made atomic; the Stage 3 guide explains delivery uncertainty.

## Remaining stages

Stages 2 and 3 provide the Baileys adapter, disabled QR pairing entry point, external credentials, explicit group configuration, persistent reminders, delivery retries, downtime recovery, confirmed changes/cancellations, and opt-in genuine mentions (disabled by default). Real-account interoperability and mention notification behavior remain untested. Stage 4 remains pending: Oracle Cloud Always Free deployment, systemd, backups and operations documentation.

Baileys is an unofficial WhatsApp integration. Future use may risk account restriction and must respect platform rules and group consent; its live connection is disabled by default.

SQLite uses Node's built-in `node:sqlite` API; Node 24 may print an experimental warning. See the [Node 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html) and [Vitest guide](https://vitest.dev/guide/) for upstream references.
