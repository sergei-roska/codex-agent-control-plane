# HAR-04 launcher handoff

Status: implementation and focused verification complete.

## Confirmed source causes

- `src/launcher-projects.js:95-116` stores runtime logs only in `rt.logs`. `runStart()` collects child output in memory at `:344-388`; `status()` at `:437-440` reads only that process-local array. `init()` at `:183-201` reconstructs manager records/status but does not recover logs. A new manager therefore loses the original child startup stderr.
- `runStart()` awaits token creation before spawn (`:332-338`); a token error is thrown to the active caller and is not recorded durably. Spawn/setup failures use the same memory-free catch (`:385-389`).
- `RUNNING_MARKERS` at `:18` accepts generic `Codex Universal A2A` as success. Actual success text is emitted only by `server-bootstrap.js:52` as `Codex Universal A2A listening at http://...`; a generic diagnostic containing the product name can falsely set `running`.

## Proposed narrow design

Persist only a structured, bounded, sanitized last-startup diagnostic in `runtimeDir/projects/<project-id>/last-startup.json` with a 0700 project directory and atomically written 0600 file. Capture stderr only while starting; never persist stdout. Include outcome/stage, timestamp, error code/message, and bounded sanitized stderr on failure. `status()` exposes this record after manager reinit. Startup-record I/O errors stay diagnostic and must not change status to running or mask the original startup error. Keep the `start()` API nonblocking. Treat the exact successful listener line as readiness.

No live server, session, database, or model action performed.

## Implementation

- `src/launcher-projects.js` now atomically stores only a structured last-startup record in `runtimeDir/projects/<id>/last-startup.json`. Project directory mode is 0700 and file mode is 0600. Records include startup stage/outcome and sanitized bounded error/stderr; stdout is never persisted. During startup, stderr is persisted on the first chunk and then at 512-character increments, with at most 24 writes and an 8000-character cap. `status()` recovers the record after manager reinitialization and includes a failure summary in logs. Token/setup/spawn and child-before-listener failures are recorded. Diagnostic write failure is logged but does not alter status or mask the original failure.
- Running is now recognized only from the actual `Codex Universal A2A listening at http://` message on stdout. A 2000-character rolling stdout buffer handles markers split across chunks; generic branding or stderr cannot set status to running.
- `onGone()` resolves its child-specific promise, then checks that child still owns the runtime before changing startup diagnostics or manager state. This prevents a late old-child event from overwriting a newer attempt.
- `test/launcher-projects.test.js` covers token and spawn failure recovery, sanitized stderr, stdout exclusion, restrictive file modes, and false readiness markers.

## Verification

- `node --test --test-isolation=none --test-reporter=spec test/launcher-projects.test.js`: 32 passed, 0 failed.
- `git diff --check -- src/launcher-projects.js test/launcher-projects.test.js`: passed.
- Initial focused runs exposed stale marker fixtures and a split-marker expectation; updated tests to use the real `server-bootstrap.js` success line and verify split delivery. A static review also found late-child diagnostic overwrite risk; ownership check and regression test were added before final verification.

## Independent privacy finding and repair

A static review found JSON-quoted credential keys/values bypassed the first redaction expression, so an early token error could persist a credential in `message`. `sanitizeStartupText()` now redacts common quoted JSON and single-quoted mapping forms as well as assignment syntax. A regression constructs a dummy value at runtime and asserts it is absent from disk; no test credential is printed or committed as a literal. Focused command `node --test --test-isolation=none --test-reporter=spec --test-name-pattern='redacts credential values with quoted JSON keys and values|persists sanitized startup stderr without stdout' test/launcher-projects.test.js`: 2 passed, 0 failed.
