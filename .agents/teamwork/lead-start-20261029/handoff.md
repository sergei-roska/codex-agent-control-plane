# Lead startup worker handoff

## Verified

- Captured exact pre-edit working-file baselines for `src/app-server-switch.js`,
  `src/concurrent-delivery-engine.js`, `test/app-server-switch.test.js`, and
  `test/concurrent-delivery-engine.test.js` in `evidence/baseline/`.
- Root cause: the wrapper retained `currentHome === null` for the default
  profile, while the engine pinned the concrete default home. Its run guard
  compared that pin to null and raised `provider_home_changed`.
- `src/app-server-switch.js` now snapshots the effective home identity when an
  instance is created or swapped. It uses selected home, `baseOptions`,
  `CODEX_HOME`, or `~/.codex`, then resolves symlinks. Expected-home checks and
  captured preparation identity use that snapshot. Account swap checks still
  compare the active profile to the instance's selected profile.
- Added a real switching-wrapper plus concurrent-engine integration variant
  with a stub model. It completes planning and acceptance using the default
  profile and verifies the first planner execution fact has start and terminal
  records. The existing selected-profile swap rejection test still passes.

## Verification

- `env -u NODE_TEST_CONTEXT node --test test/app-server-switch.test.js` - 8
  passed, 0 failed.
- `env -u NODE_TEST_CONTEXT node --test --test-name-pattern='default-profile'
  test/concurrent-delivery-engine.test.js` - 1 passed, 0 failed.
- An earlier combined focused run failed the new fixture before it was made
  hermetic: wrapper strips internal `expectedCodexHome` before forwarding and
  test initially supplied missing `processIdentity`. The fixture was corrected;
  above commands pass.
- Full `test/concurrent-delivery-engine.test.js` was interrupted after over
  100 seconds; 50 cases had passed, the initial fixture failed, and one case was
  canceled by interruption. Do not treat this as a full-suite result.

## Pending

- Lead review of the source/test diff.
- No live task, database, or service was touched.

## Lead acceptance and runtime

- Independent review APPROVE, no blocking findings; see review.md. Reviewer ran 8 wrapper and 6 focused engine tests plus default/env/base/selected/symlink identity probes with swap rejection.
- Lead ran `env -u NODE_TEST_CONTEXT node --test test/server-delivery-engine.test.js test/delivery-provider-identity.test.js`: 70 passed, 0 failed, 0 skipped. Full output evidence/server-tests.log.
- evidence/regression-proof.json independently confirms saved baseline rejects the concrete default pin before any stub provider call; fixed source completes one stub call.
- Started original project 3d9c2e759c through existing launcher API. Running port 3002 PID 1785118. Authenticated /control/runtime confirms loaded app-server-switch.js SHA256 301609bd1cfb67d46b05f5ab8f3b434497d6d0913199c34c4ae4e56a7b0aed18 matches reviewed source; evidence/runtime-proof.json.
- Old task cdb27a0c-e3c5-40c2-ac4a-9005e7c041ef digest unchanged, planner turn count remains 1. No new live model task, database edits, commit, push, or history deletion. Original canceled objective deliberately preserved. New task needed for owner work; canceled objective cannot resume under current engine semantics.
- Task source delta only src/app-server-switch.js and test/concurrent-delivery-engine.test.js against saved dirty baseline. Existing wrapper test and concurrent engine source unchanged against saved copies. Full repository suite was not run for this narrow fix.
- No work pending for this repair. Original project server intentionally left running for the owner. Evidence under .agents is ignored by Git and may be unavailable if local ignored files are removed.

## Owner-requested stop

Owner explicitly requested stopping the project server. POST /api/projects/3d9c2e759c/stop returned success, pid null, status stopped. Port 3002 has no listener. Do not restart without a new request. Further busy-fence investigation was canceled by owner steering; no implementation was dispatched or changed.
