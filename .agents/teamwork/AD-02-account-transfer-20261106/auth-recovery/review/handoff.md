# AD-02 auth recovery review

Date: 2026-11-06. First review verdict: REJECT. Initial rollback races and
delta-review findings are repaired. Sol independently approved the profile
lock and the adapter/active-auth selection fixes. Automatic all-window wait
and provider rebind remain AD-03 integration gates.

## Blocking findings

- `src/budget-watcher.js` automatic budget and auth paths set a candidate active
  before awaiting `switchTo`. If the switch throws, the candidate remains
  active even though no switch was confirmed. Sol reproduced active B with zero
  resumes from an initial active A.
- Busy rollback unconditionally restores the prior active profile after the
  await. Sol reproduced a delayed switch to B where the owner selected C while
  the switch was pending; the rollback overwrote C with stale A.
- The launcher activation route writes the same profile file and is reachable
  while the watcher awaits a switch.

## Criteria that passed

- Typed authentication failures and explicit provider auth state produce
  `requiresOpenaiAuth: true`; unrelated failures and null limits alone remain
  unknown.
- Existing-profile login requires explicit restored auth and preserves the
  profile home on failure, cancel, or timeout.
- Auth/budget resume checks the matching live pause; watcher entry identity is
  checked after awaited eligibility and switch operations.
- Reused focused evidence: launcher accounts 29/29, budget watcher 35/35,
  account failover 3/3, App Server switch 17/17, auth-focused lead graph 3/3,
  and named server cases 8/8.

## Repair evidence

- `src/account-profiles.js` now persists a selection revision and provides a
  synchronous compare-and-set operation. Owner activation and active-profile
  removal advance that revision.
- `src/app-server-switch.js` checks the watcher's expected active profile and
  revision before switching and after waiting for a swap. It returns busy
  without preselecting while a call is in flight, and restores a failed target
  only if its own selection revision is still current. Target creation commits
  wrapper state only after construction succeeds.
- `src/budget-watcher.js` no longer preselects candidates or rolls back after
  awaiting a switch. It passes the captured active profile and revision to the
  wrapper and resumes only after `switched` or `already_active`.
- Deterministic tests cover target creation throws, stale selection after a
  delayed swap, budget and auth switch throws, and delayed busy/throw outcomes
  after an owner activates C.

## Cross-process repair evidence

- `src/account-profiles.js` now holds a SQLite `BEGIN EXCLUSIVE` lock in a
  stable `profiles.json.lockdb` while each complete profile-state mutation
  reads and writes. All public state writer paths use the same lock. The
  process-exit regression proves SQLite releases and recovers the lock.
- Independent-process regressions prove a queued owner selection to C remains
  final and a stale CAS behind C is rejected. Public writes also preserve or
  advance selection revision correctly.
- Sol independently approved the lock implementation and its crash/race tests;
  see `/tmp/codex-ad02-profile-lock-review-20261106.md`.

## Delta review findings

- The original `src/server.js` adapter adapted `switchTo` with only the profile name and dropped
  the watcher's captured active profile and selection revision. A composed
  probe selected C during availability lookup, then the watcher selected B and
  resumed. Root now forwards all arguments through the production adapter at
  the current `src/server.js:1601` call site.
  The server regression holds B's availability read, activates C, then
  releases B and verifies there is no automatic resume, C remains active, and
  the provider wrapper remains on A.
- `src/account-profiles.js` originally performed revision check and full-state
  rename without cross-process serialization. A separate-process owner write
  to C between the stale CAS read and rename was overwritten by B. A worker
  implemented shared serialization for every profile-state writer. Sol
  independently approved the lock and tests; see the cross-process repair
  evidence above.
- Sol found the active auth candidate also bypassed conditional selection
  validation after its asynchronous availability read. Auth recovery now sends
  every eligible candidate, including the active profile, through the wrapper
  with the captured selection pin, then verifies selected profile and home.
  Unit and real-server regressions select C while A's positive auth read is
  held, then prove no resume occurs on unchecked C. Sol approved this delta.

## Verification

- `node --test test/account-profiles.test.js test/app-server-switch.test.js test/budget-watcher.test.js test/account-failover-context.test.js test/launcher-accounts.test.js` - 101 passed, 0 failed after cross-process repair (initial run before that repair: 97/97).
- `node --test test/budget-watcher.test.js test/account-failover-context.test.js` - 43 passed, 0 failed after active-auth-candidate repair.
- `node --test --test-name-pattern='an auth pause waits for explicit account recovery and resumes through the automatic auth path once|an auth recovery does not resume on a profile selected during active-account verification|the server forwards the watch selection pin when an owner changes profiles during availability lookup|a budget pause with auto-switch on switches to another account and resumes at once' test/server.test.js` - 4 passed, 0 failed.
- `node --test --test-name-pattern='the server forwards the watch selection pin when an owner changes profiles during availability lookup|a budget pause with auto-switch on switches to another account and resumes at once|describePause gives an auth pause|startup registers INPUT_REQUIRED lead tasks paused for budget or auth|an auth pause waits for explicit account recovery|budget auto-resume metadata cannot resume' test/server.test.js` - 10 passed, 0 failed.
- `node --check src/server.js && node --check test/server.test.js && git diff --check -- src/server.js test/server.test.js src/account-profiles.js test/account-profiles.test.js` - passed.
- `node --test --test-name-pattern='explicit auth failures|only explicit account auth state|unknown lead error' test/lead-graph.test.js` - 3 passed, 0 failed.
- `node --test --test-name-pattern='describePause gives an auth pause|startup registers INPUT_REQUIRED lead tasks paused for budget or auth|an auth pause waits for explicit account recovery|budget auto-resume metadata cannot resume' test/server.test.js` - 8 passed, 0 failed.
- Full `node --test test/server.test.js` remains unqualified: the earlier run was interrupted after 110.29 seconds with 19 passed, 0 failed, 1 cancelled and a pending top-level test. It was not rerun.

AD-02 auth/cross-process selection repairs are independently approved. No
provider was contacted; no staging or commit was performed.
