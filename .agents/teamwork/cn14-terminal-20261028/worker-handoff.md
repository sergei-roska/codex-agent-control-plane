# CN14 terminal implementation

Production source currently frozen for independent critic. Files changed:
src/delivery-role-service.js, src/task-executor.js,
src/concurrent-delivery-engine.js, src/server.js, src/delivery-engine-router.js.
Tests changed: test/delivery-role-service.test.js,
test/server-delivery-engine.test.js. Additional owned tests pending.

Implemented separate durable host drain/provider-close/final failure retirement;
same-owner exact saved tuple + qualified cleanupReceipt + independently gone
original group; noEffect/normal result adapter unchanged. Failure proof/replay
closes executor reservation and journal after unknown store settlement. Private
bytes/report and measured shared workspace drift retained, no publication/requeue.
Durable incomplete phases fence future host admissions; released final projection
allows next host lifecycle while role proof remains. Provider close promise survives
caller timeout; no post-close lazy identity accessor. Constructor saves new host
provider identity to include alongside persisted older groups. Scheduler inFlight
promises now drain before provider close.

Separate lead-requested V43 repair maps validated evidence-ref/v1 objects to durable
ev_ IDs and rejects malformed refs, preserving strict proof digest validation.
V43 worker reports real composed evidenceStore fixture PASS 1 FAIL 0.

Verified commands (env -u NODE_TEST_CONTEXT node --test):
- test/delivery-role-service.test.js test/task-executor.test.js: PASS 61 FAIL 0
  before added terminal tests. worker-unit.log.
- --test-name-pattern='terminal failure|shutdown terminal'
  test/delivery-role-service.test.js: PASS 9 FAIL 0. worker-terminal.log.
- --test-name-pattern='shutdown no-publication recovery'
  test/concurrent-delivery-engine.test.js: PASS 6 FAIL 0. worker-recovery.log.
- --test-name-pattern='owner pause facade|cooperative held lost'
  test/concurrent-delivery-engine.test.js test/server-delivery-engine.test.js:
  PASS 8 FAIL 0. worker-admission.log.
- --test-name-pattern='cooperative held lost' test/server-delivery-engine.test.js:
  PASS 1 FAIL 0. worker-host-final.log.

Earlier worker-engine.log predates corrected error-code compatibility and is stale;
initial host fixture failures were fixture planner role and openStateDatabase API
errors, repaired. Current production deltas after last verification require reruns.
No full suite run. No Git mutation or live providers/services touched.

Remaining: positive safe-close/reopen/new intake, ordinary successful real-receipt
read-only exclusion, retained two-generation/preparation reopen, caller timeout
and late provider death, await-boundary mutation/snapshot failure. Independent
critic reviews source now; notify root/critic before additional source changes.

## Completion verification and authorized retry repair

Current acceptance additions already existed at continuation start despite the
stale remaining list above. Verified actual-receipt successful read-only exclusion,
request/settings/receipt mutation during lane completion await, unavailable shared
snapshot, retained older/newer provider groups across preparation reopen, and
scheduler callback drain. No missing implementation was inferred from stale notes.

This continuation changed src/concurrent-delivery-engine.js and
 test/server-delivery-engine.test.js only. Critic established a real timeout bug:
internal shutdown could finish after caller timeout, persist released, then the
retry fence reset it to draining while reusing the completed shutdown promise.
Root authorized repair. fenceShutdown now permits released -> draining only when
shutdown was not already requested for this engine instance; repeated fences
preserve final phase. A fresh host still starts with admission open after released.

Host test now exercises immediate and delayed provider close, caller timeout,
late internal completion before retry, durable released after retry, repeated
completed close, and same-workspace/state reopen with legacy-default selection.
It preserves exact attempt/execution rows and old concurrent mapping and allows
fresh legacy intake without another worker call. Separate fresh concurrent intake
also passes. Its prior hang was a fixture report omitting the verify-source.js
check actually executed; report now includes that evidence and test has timeout.
The uncorrected bounded run timed out; the original unbounded and bounded test
processes were explicitly terminated. Only owned disposable tests were stopped.

Final commands, all exit 0:
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='cooperative held lost|released shutdown' test/server-delivery-engine.test.js
  PASS 3 FAIL 0; worker/final-host.tap.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='terminal failure|shutdown terminal|shutdown preparation|shutdown reconciliation|shutdown writable' test/delivery-role-service.test.js
  PASS 14 FAIL 0; worker/final-role.tap.
- env -u NODE_TEST_CONTEXT node --test --test-name-pattern='staged shutdown|shutdown no-publication recovery|owner pause facade' test/concurrent-delivery-engine.test.js
  PASS 15 FAIL 0; worker/final-engine.tap.
- node .agents/teamwork/cn14-terminal-20261028/critic-released-timeout-probe.cjs
  PASS 1 FAIL 0; worker/released-repaired.log; released before and after retry.

Final hashes: worker/final-sha256.txt. Ignored local evidence may disappear.
No broad suite, prohibited filter test, Git mutation, live provider invocation,
existing service restart, installation, or account/settings change performed.
Only disposable fixture settings changed to exercise legacy-default reopen.
Production is frozen again for independent review. Root owns final integration,
docs, broad freeze gates, and acceptance decision. No scope expansion.

## Full checkpoint stall investigation and test-only repair

Root full checkpoint timed out at 300 seconds without a TAP summary. Root copied
its deleted fixture SQLite/WAL into integration-closeout-20261028/full-stall-snapshot.
Snapshot showed terminal execution/qualified receipt but provider_closing attempts
empty and deleted lane paths. That is cleanup artifact, not proof that the original
production eligibility check failed.

Reproduced with:
env -u NODE_TEST_CONTEXT timeout --signal=TERM --kill-after=5s 60s node --test --test-name-pattern='cooperative held lost' test/server-delivery-engine.test.js
Result exit124; immediate variant passed; late failed at 5.17s with
concurrent_shutdown_unsafe from #drainRoleCalls, PromiseRejectionHandledWarning,
and leaked HTTP until timeout. worker/stall-repro-host.tap retains exact failure.

Changes only test/server-delivery-engine.test.js:
- Attach Promise.allSettled immediately when overlapping close promises are made.
- Await retained engine.shutdownPreparation rejection while worker is still held,
  preserving the first unsafe-close/ownership/admission assertions; then release.
  Caller timeout may precede the internal 5s drain rejection. Reusing that operation
  on an immediate retry is expected API behavior, not an established source bug.
- idleConcurrentServer owns its temp root cleanup after runtime.close, and finally
  closes disposable HTTP/state handles before removing files on failed assertions.
  A failed production close remains a test failure; cleanup does not certify safety.
No timeouts increased. No production source edit for this repair.

Final full-file command:
env -u NODE_TEST_CONTEXT timeout --signal=TERM --kill-after=5s 120s node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/server-delivery-engine.test.js
PASS55 FAIL0, exit0, 36.24s; worker/stall-final-server.tap.
Earlier cleanup-only repair full file also PASS55/55; stall-full-server.tap.
Focused retained host cleanup-only repair PASS2/2; stall-repaired-host.tap.

Failure cleanup verification:
env -u NODE_TEST_CONTEXT timeout --signal=TERM --kill-after=5s 30s node --test --test-reporter=tap --test-name-pattern='cooperative held lost.*immediate' .agents/teamwork/cn14-terminal-20261028/worker/cleanup-failure-probe.cjs
Expected exit1 PASS0 FAIL1 CANCEL0, 5.72s, no timeout or leaked handles. Probe loads
original test through Module and injects one failing assertion only in scratch;
worker/cleanup-failure.tap exposes exact injected error. Source tests not weakened.

Frozen production/paired-test hashes: worker/stall-final-sha256.txt. Production
hashes unchanged; only host test hash changed. Root owns critic re-review/full gate.
V14 amended plan now belongs to owner-decision-20261028/plan.md; no V14 source edit.
