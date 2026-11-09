# Terminal implementation review

Verdict: REJECT
Status: complete
Scope expansion: none

## Blocking finding

src/server.js:1208 (with src/server.js:1239-1242 and
src/concurrent-delivery-engine.js:373-376): A close retry can overwrite a completed
shutdown phase with draining and then release ownership using a cached successful
projection. This leaves the next host permanently admission-fenced.

Evidence: ran env -u NODE_TEST_CONTEXT node
.agents/teamwork/cn14-terminal-20261028/critic-released-timeout-probe.cjs.
Exit 1 with phaseBeforeRetry=released and phaseAfterSuccessfulRetry=draining.
The probe uses the real startServer and existing disposable offline host fixture:
provider.close remains pending beyond the 5-second caller deadline, the first
host.close rejects while retaining state, then provider.close resolves and the
internal operation finishes safely. A second host.close succeeds and closes the
database. Reopening SQLite shows draining rather than released.

Read: close always invokes durable fenceShutdown before checking its retained
concurrentShutdownPromise. That promise is cleared only on rejection. Therefore
an internal operation that succeeds after its caller deadline remains cached;
the next close resets released to draining, skips preparation/finalization, and
releases locks from the earlier safeToRelease result. The constructor at
src/concurrent-delivery-engine.js:169-170 treats that phase as shutdownRequested.
No wrapper or later finalizer restores released on this cached-success path.

Fix: make retries preserve the completed phase when consuming the already
successful pending shutdown, while retaining admission fencing in memory. Add a
regression that times out the caller, lets the internal operation complete before
retry, closes successfully, and proves fresh host intake after database reopen.

## Other current evidence

Read the actual git diff/status and exact five-file production delta against
originals/src/. The large inherited dirty baseline is not treated as this task's
scope expansion. No reviewed source/tests/config or Git state was changed.

Ran focused current tests:

env -u NODE_TEST_CONTEXT node --test
--test-name-pattern='terminal failure|shutdown terminal|shutdown no-publication recovery|owner pause facade|cooperative held lost'
test/delivery-role-service.test.js test/concurrent-delivery-engine.test.js
test/server-delivery-engine.test.js

Result: PASS 23, FAIL 0, duration 32624 ms. Evidence: critic-current.tap.
This command selected focused tests only and did not execute the prohibited
candidate-filter test. It does not cover tests added after this run began.

Ran existing predecessor probes independently against current source:
- review-reopen-group-probe.cjs: exit 0; live newly observed group retained in
  provider_closing phase and release refused.
- review-succeeded-probe.cjs: exit 0; actual qualified cleanup receipt on a
  succeeded read-only attempt excluded from terminal failure reconciliation.

Read current receipt/process/lane/request/settings checks, post-lane-await
revalidation, executor failed/canceled replay and unchanged final lifecycle and
effectsSettled guards. No additional concrete defect established in these paths.
No full suite, live provider, existing service, account or settings operation run.

## Acceptance disposition

1. Drain/admission ordering: partial PASS from code and held-worker host test;
   full matrix not completed after decisive failure.
2. Original process identity: bounded PASS for real-group death negative and
   reopen probe; remaining targeted generation/observation cases need final run.
3. Failure-only retirement: bounded PASS in focused tests; bytes/report/drift and
   no-publication assertions passed.
4. Replay/noEffect identity: bounded PASS for executor replay and existing
   no-publication negatives in focused tests; full crash-reopen matrix unverified.
5. Retry/reopen/release: FAIL from independent host reproduction above.
6. Raw receipt-only engine case: existing focused recovery negatives passed;
   this is not authorization to weaken the process requirement.

The new released-host/intake test's reported hang is missing evidence, not a
second demonstrated product defect. The lead/worker are investigating it.
Tests were changing concurrently; production remained frozen during review.
A corrected candidate needs a delta review and fresh hash checkpoint.

## Reviewed SHA-256 checkpoint

- src/delivery-role-service.js: f2182cfef9df24484fe19020ac9ebbd27716ce090db8c75f8647ecc002d48346
- src/task-executor.js: 96e8c7fd09e693a22b8b81a143a7217621b34d847848e61beaaffdea7c5d9b91
- src/concurrent-delivery-engine.js: afbdf9bdf0bea1001647c98b99e7e978eb60bc2f58ea5b76163cd6bd15c71280
- src/server.js: 931777ea1ee27fc1286cc2db1798f80328dca4c42096d0e97aba25cc59ad3062
- src/delivery-engine-router.js: 04c7b14355e0d62b8306592aedbdffbf220e804cf10c158fb3f8c4d7499c4274
- test/delivery-role-service.test.js: bd2e3a97b7f7cc025aa6b4bcfb5aa8735e97356691ab6b879bc8325f60b33fd3
- test/task-executor.test.js: 11afe44fcd3511818338a0a6d4963394aebefec96254f327ae7ee3cba07ed345
- test/concurrent-delivery-engine.test.js: 6ec75e081f1811445ab360eaef3641356233e323613e69976dca52ba816f4cd2
- test/server-delivery-engine.test.js: 0eb86274873a2f39bb7903a54f41bcc6ca8a34b1a8c708ae71bfbba9620171f3
- test/delivery-engine-router.test.js: c8a7947f996fb27b21bc3297168d8e702039445278e6d017674c299de96445fe

Pitfall: a caller timeout and an internal shutdown completion are separate events; never reset durable completion while reusing its cached successful projection.
