# Assignment validation and offline reminder review

Validation completed on 2026-10-15: **266 tests passed across 12 files, zero failures**. TypeScript build, mock reminder demo and Git whitespace checks passed. `npm audit` reported zero vulnerabilities. Git printed informational LF/CRLF conversion warnings, without whitespace errors.

The previous bounded pilot discarded drafts before the confirmation workflow unless there was exactly one assignment with a recognized course, title, SUST Moodle destination and deadline more than 24 hours away. The rule-based parser could not fully extract the original natural-language announcement, so these pilot gates prevented a correction preview. This establishes the offline rejection cause; it does not prove the original live message reached the socket.

Authorized detected assignments now enter a numbered preview with explicit missing-field labels. Admins edit individual fields by replying to the current preview. Ambiguous, missing or expired deadlines prevent registration and reminders. Optional unknown subjects, titles and destinations remain unspecified unless corrected; they are never invented. Multiple assignments and separate Moodle, email and custom destinations are supported. Authorization, quote matching, atomic registration, duplicate constraints and group isolation remain enforced.

The unchanged private original announcement passed its local regression: one pending preview requesting clarification, no assignment registration and no reminder schedule before correction. This fixture remains Git-ignored; its test skips on machines where the private file is absent. Synthetic tests provide portable coverage without publishing the original text.

The five-minute mock test uses temporary SQLite storage, explicit test-only policy and deterministic time. It verifies preview, quoted admin approval, one registration, one persistent reminder exactly five minutes after approval, restart recovery, correct deadline/destination formatting, unauthorized-worker rejection and no duplicate delivery. Separate regressions cover transactional scheduling failure and a crash between registration and scheduling. The override is disabled by default and on shutdown. Normal 72/24/2-hour schedules remain intact; bounded tests process only their selected test job.

Diagnostics contain fixed codes and counts only. SDK log contents are discarded in the controlled socket. General delivery acknowledgment means the adapter returned successfully; the controlled real socket additionally requires matching WhatsApp server acknowledgment. Neither establishes recipient delivery or exactly-once behavior. Uncertain controlled sends are not automatically retried.

Files changed for this task:

- `src/parser.ts`
- `src/bot.ts`
- `src/whatsapp/adapter.ts`
- `src/delivery/engine.ts`
- `src/reminders/worker.ts`
- `src/pilot/controlled.ts`
- `src/pilot/controlled-main.ts`
- `src/pilot/controlled-socket.ts`
- `tests/controlled.test.ts`
- `docs/controlled-testing.md`

New files for this task:

- `src/diagnostics.ts`
- `src/pilot/validation.ts`
- `tests/validation-regression.test.ts`
- `docs/validation-fix.md`

Other pre-existing working-tree changes were not committed or reverted. In particular, AGENTS.md was not modified by this task. Before/after comparisons confirmed the existing pilot SQLite files, private original announcement, saved authentication and persistent pilot environment file were unchanged.

Readiness: offline functionality is ready for another supervised test, but do not start the launcher yet. Obtain fresh approval covering correction previews/feedback, registration success and one reminder, then agree on a separate isolated run or reviewed resume preparation. The existing historical controlled-run ledger is deliberately not reset; the CLI refuses a previous run. The controller's same-policy offline recovery does not automatically migrate that historical live record.

The safest next live scenario is one incomplete announcement from the verified leader, one admin deadline correction using an explicit future Africa/Khartoum timestamp, approval of the latest preview, one saved assignment and one approved five-minute reminder. Keep mentions disabled and use only the verified private group. Real message reception, identity resolution, corrected quote rendering, server acknowledgments and recipient notifications must still be verified. Natural-language dates remain conservative and may require admin correction. No new live connection, real message, deployment, commit or push occurred during this task.
