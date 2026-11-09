# Cleanup admission race handoff

Status: complete.

Closed the reviewed race in `src/codex-app-server.js`. `_assertTurnAdmission(ctx)` now supplies the existing generation-scoped quarantine behavior at initial admission and rechecks it after awaited setup, immediately before `onTurnStart`, and again before the turn request. The guard matches only the captured context generation, so an old run cannot inherit a replacement generation's quarantine state.

Added a focused regression in `test/codex-app-server.test.js`: hold the second run in `config/read`, fail the first run's cleanup, release setup, then verify the second run reports `background_terminal_cleanup_blocked`, with `outcomeUnknown: false`, no `onTurnStart`, and no additional `turn/start`.

Verification:
- `node --test --test-name-pattern='performs initialize handshake|waits for thread-scoped|cleanup RPC failure|quarantines new turns|rechecks quarantine after awaited setup|cleanup ignores an abort|bounds cleanup RPC|generation has changed|routes concurrent turns|does not resume a thread started' test/codex-app-server.test.js` - 10 passed, 0 failed.
- `node --check src/codex-app-server.js` - passed.
- `node --check test/codex-app-server.test.js` - passed.
- `git diff --check` - passed.

The full test file was not rerun; prior handoff records 98 passed and 3 known baseline failures. No live Harness, model, service, or Git operations were performed.
