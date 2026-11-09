# Recovery wiring implementation checkpoint

Status: source/test frozen; independent review pending. Focused suite 91/91 pass.
Changed only src/concurrent-delivery-engine.js and test/concurrent-delivery-engine.test.js.
Original snapshots are in worker/originals/. No RoleService API changes.

Engine now delegates executor recoveryProofAdapter to RoleService.recoveryProofFor.
Shutdown fences all existing controllers before awaiting any cycle/scheduler, drains
RoleService calls once, and scans every durable run including canceled runs without
controllers. Exact nonterminal attempts are prepared through trusted RoleService;
only if preparation succeeds does the engine call requestLifecycleRecovery and
executor.recover. Existing lifecycle shutdown projections retain final authority.
No direct claim writes, owner policy changes, new controllers or provider calls.

Six real HTTP integration modes pass: owned private lane safe retry shutdown,
cooperative refusal, unknown provider refusal, unknown publication refusal,
pending inbox refusal after honest settlement, canceled SQLite reopen recovery.
Positive repeated shutdown is idempotent. Private bytes retained; shared tree
unchanged. Lost acknowledgement is real send AbortError under owner cancel;
executor externalTaskId remains null. Fake providers only, disposable repositories.

Verification:
- node --check src/concurrent-delivery-engine.js: pass.
- node --check test/concurrent-delivery-engine.test.js: pass.
- env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='shutdown no-publication recovery' test/concurrent-delivery-engine.test.js
  6 tests, 6 pass, 0 fail; integration-test.log.
- env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js test/delivery-role-service.test.js test/task-executor.test.js test/delivery-lifecycle.test.js
  91 tests, 91 pass, 0 fail; focused-suite.log.

Remaining: ordinary inherited cooperative safe retry-close remains unqualified and
refused. No claim that whole CN14 is done. No Git mutations, services, live models,
account/settings changes or subagents. Ignored logs may disappear.

## Final timing and test-stop clarification

The 91-test suite loaded the test before the final hook-only adjustment: the
releaseWorker after hook is now registered before createHarness cleanup, so a
failed pre-release assertion releases the held provider before shutdown teardown.
All six test bodies and production code are unchanged since their passing run.
This final hook-only delta is syntax-checked, not yet executed to completion.
source-frozen.json records final inputs; hashes unchanged after verification.
Engine lines235,364,400; test integration cases start line784. Per-file exact
unified deltas are concurrent-delivery-engine.js.diff and
concurrent-delivery-engine.test.js.diff; original snapshots under originals/.

Two extra commands began before the lead's stop-tests message arrived. Both were
terminated on receipt; partial logs are not qualification evidence:
- env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/project-delivery-controller.test.js test/server-delivery-engine.test.js test/delivery-host-controls.test.js
  Interrupted; controller-host-suite.log.
- env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='shutdown no-publication recovery' test/concurrent-delivery-engine.test.js
  Interrupted; frozen-integration-test.log.
No further tests started. Lead owns final affected frozen verification after review.

## Authorized drain repair after affected timeout

Lead affected run timed out at180s; original lead logs preserved unchanged.
Read-only repro: authoritative-effects host matrix first six candidate cases passed,
then unknown role execution failed at5152ms and left HTTP fixture alive. Instrumented
shutdown logged active0/controllers0/storedRuns0 with a durable unknown role row
(host-drain-instrumented.log:65). Server close hit its5s bound at server.js:1230;
engine later reported safe true at5156ms, after caller timeout. The durable row was
fabricated fixture residue after stored run removal. The new unconditional global
drain had extended the old controller-only behavior to this idle-close case.

Repair authorized by lead: drain only actual RoleService.active calls. Durable
unknown rows remain checked by trusted recovery and the unchanged final lifecycle
projection; they cannot drain via polling. No server.js or owner-policy changes.
Existing unknown real integration case now deterministically intercepts20ms drain
waits once active.size0, requires zero such waits and shutdown refusal. Before repair:
1test,0pass,1fail; durable-drain-before.log. Exact command:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='shutdown no-publication recovery integrates unknown' test/concurrent-delivery-engine.test.js

Read-only host diagnostics (both exit124 due intentionally bounded leaked fixture):
timeout --signal=TERM --kill-after=5s 45s env -u NODE_TEST_CONTEXT node --test --test-reporter=spec --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='legacy downgrade fences authoritative effect records' test/server-delivery-engine.test.js
  host-drain-diagnostic.log.
timeout --signal=TERM --kill-after=5s 20s env -u NODE_TEST_CONTEXT node --test --test-timeout=12000 --test-reporter=tap --require=./.agents/teamwork/cn14-recovery-wiring-20261027c/worker/host-drain-diagnostic.cjs --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='legacy downgrade fences authoritative effect records' test/server-delivery-engine.test.js
  host-drain-instrumented.log; preload wraps shutdown only for logging.

Separate launcher failure: affected TAP reports null exit code after SIGTERM,
launcher-startup.test.js:98. Exact isolated case passed1/1:
timeout --signal=TERM --kill-after=5s 15s env -u NODE_TEST_CONTEXT node --test --test-reporter=spec --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='launcher becomes ready on a free port' test/launcher-startup.test.js
  launcher-startup-diagnostic.log. launcher.js emits readiness before installing
SIGTERM handler; a readiness/signal race is plausible, not established as new engine
regression. No launcher edits or claim this affected failure is fixed.

Repair source/test frozen again, hashes/diffs updated. Prior frozen hashes retained
source-frozen-before-drain-repair.json. Syntax checks pass. Running:
env -u NODE_TEST_CONTEXT node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js test/server-delivery-engine.test.js
  drain-repair-engine-host.log.

Repair final verification: engine+host74 tests,74pass,0fail in36738ms;
drain-repair-engine-host.log. Frozen repair hashes unchanged. Authoritative
unknown-role fixture now passes; no host process leak. No further tests started.
Independent re-review and lead affected frozen suite pending.
