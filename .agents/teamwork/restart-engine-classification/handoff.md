# Restart engine classification handoff

## Verified

- Exact pre-edit copies of `src/server.js` and
  `test/server-delivery-engine.test.js` are in `evidence/baseline/`.
- Root cause was confirmed in the existing startup snapshot: every persisted
  orchestrator task ID entered `legacyTaskIds`, including IDs mapped to
  `concurrent-v1` in the same validated project mapping table.
- `storedDeliveryMappings` now returns concurrent run IDs. Startup removes only
  those mapped IDs from the fallback legacy task set, while retaining unmapped
  historical task IDs and mapped legacy IDs. Existing unknown mapping and
  project identity checks remain in force.
- Regression restarts a disposable server with a canceled concurrent objective,
  an INPUT_REQUIRED A2A task mapped to it, and an unknown pre-start planner
  ledger row. The first new request goes through HTTP JSON-RPC and reaches the
  concurrent engine. The old task state and unknown planner row are asserted
  unchanged. A stub concurrent engine avoids provider/model work.
- Before the source fix, the same test reached the HTTP route but returned a
  task failure with `Delivery is busy with an active run on the other engine`
  and zero engine calls. After the fix it passes with one engine call.

## Verification

- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='concurrent engine admission recognizes persisted terminal legacy task states|restart excludes a persisted concurrent task|durable legacy mappings block concurrent intake' test/server-delivery-engine.test.js`
  - 12 passed, 0 failed. Includes active unmapped legacy fencing and mapped
    legacy fencing.
- `env -u NODE_TEST_CONTEXT node --test test/delivery-engine-router.test.js`
  - 11 passed, 0 failed, including legacy resume placeholder selection.
- `git diff --check -- src/server.js` passed. `git diff --no-index --check`
  comparing the baseline test copy with the edited test reported no whitespace
  diagnostics; exit 1 indicates the expected file difference.
- No live services or live databases were started or modified.

## Pending

- Independent review of the scoped source and test diff.

## Lead acceptance

- Independent APPROVE, no blocking findings: review.md. Reviewer ran 14 focused server checks and 11 router tests, independently reran baseline HTTP failure and fixed HTTP success. Stub engine proves admission, not live model/UI execution.
- Full server suite: `env -u NODE_TEST_CONTEXT node --test test/server-delivery-engine.test.js` passed 67/67, no failures/skips, evidence/server-tests.log.
- Exact baseline and candidate production startup classification/helper code evaluated on live SQLite in read-only mode: before busy, fixed true; all task rows unchanged. See evidence/exact-startup-preflight.cjs and .json. Candidate server.js SHA256 1c5d12d37661b1e882c96c93691719a0647fa2bb0e9b4818a0a0e9e39d3bf5c6.
- Source delta only src/server.js and test/server-delivery-engine.test.js against saved dirty baseline. Prior default-home fix preserved. No live servers started, no live tasks submitted, no database edits/history cleanup, no commits/pushes.
- Owner's explicit stop request persists: launcher8081/project3002 remain stopped. Fixed source will load at the owner's next normal startup. Do not restart on a handoff alone.
- No further implementation pending for this repair. Evidence in ignored local teamwork directory may disappear if ignored files are cleaned.
