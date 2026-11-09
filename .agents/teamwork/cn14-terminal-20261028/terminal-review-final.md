# Terminal retry delta review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

This is a delta review of the repair to the blocking finding in terminal-review.md.
It approves the bounded terminal change for the next independent challenge. It is
not full CN14/CN15 matrix acceptance or live rollout authorization.

## Inspected repair

Read: src/concurrent-delivery-engine.js:372-377 captures alreadyRequested before
latching shutdownRequested and only resets a persisted released phase when this
engine instance starts a new shutdown lifecycle. The same host retry therefore
retains released while consuming its previously completed operation. A fresh
engine constructed from a released database starts with shutdownRequested=false,
so its next shutdown still gets a fresh draining phase. Admission remains fenced
in memory during shutdown. No final lifecycle/effect or process check was weakened.

Compared SHA-256 against terminal-review.md: only concurrent-delivery-engine.js
and server-delivery-engine.test.js changed. The other four production files and
other reviewed tests are identical. Read Git diff/status and precise delta against
originals/src/; inherited work remains outside the terminal delta.

Read: host regression uses both immediate and delayed provider close. The delayed
case waits for caller timeout, then permits internal release before caller retry,
asserts durable released, repeated close, no duplicate invocation/provider close,
private report/shared drift and no publication. Legacy-default reopen preserves
exact old attempt/execution rows and original concurrent mapping, and accepts a
fresh legacy run. Separate reopened concurrent host accepts fresh work and reports
the real verification check it executes. The earlier unbounded fixture hang was
corrected by reporting that executed check, not by weakening production acceptance.

## Independent runs

Ran env -u NODE_TEST_CONTEXT node
.agents/teamwork/cn14-terminal-20261028/critic-released-timeout-probe.cjs.
Exit 0: phaseBeforeRetry=released, phaseAfterSuccessfulRetry=released.
This is the same previously failing independent reproduction without changes.

Ran env -u NODE_TEST_CONTEXT node --test
--test-name-pattern='cooperative held lost|released shutdown|staged shutdown|shutdown no-publication recovery|owner pause facade|terminal failure|shutdown terminal|shutdown preparation|shutdown reconciliation|shutdown writable'
test/server-delivery-engine.test.js test/concurrent-delivery-engine.test.js
test/delivery-role-service.test.js.

Result: PASS 32, FAIL 0. Evidence: critic-final.tap. Covers original group absence,
preparation reopen with old/new groups, scheduler callback drain, receipt-success
exclusion, post-await identity mutations, snapshot failure, replay, no-publication
recovery negatives, both host timeout modes, and fresh concurrent/legacy intake.
Prior unchanged bounded review evidence remains in terminal-review.md. No broad
suite or prohibited candidate-filter test ran. No live providers, existing
services, accounts, settings outside disposable fixtures, Git state, or reviewed
files were changed.

## Final reviewed SHA-256

- src/delivery-role-service.js: f2182cfef9df24484fe19020ac9ebbd27716ce090db8c75f8647ecc002d48346
- src/task-executor.js: 96e8c7fd09e693a22b8b81a143a7217621b34d847848e61beaaffdea7c5d9b91
- src/concurrent-delivery-engine.js: 1509274e3fd57b0330a0caf7183624269464f71ff012f32e8f9a56ba575c2d1d
- src/server.js: 931777ea1ee27fc1286cc2db1798f80328dca4c42096d0e97aba25cc59ad3062
- src/delivery-engine-router.js: 04c7b14355e0d62b8306592aedbdffbf220e804cf10c158fb3f8c4d7499c4274
- test/delivery-role-service.test.js: bd2e3a97b7f7cc025aa6b4bcfb5aa8735e97356691ab6b879bc8325f60b33fd3
- test/task-executor.test.js: 11afe44fcd3511818338a0a6d4963394aebefec96254f327ae7ee3cba07ed345
- test/concurrent-delivery-engine.test.js: 6ec75e081f1811445ab360eaef3641356233e323613e69976dca52ba816f4cd2
- test/server-delivery-engine.test.js: dff4045dd6856d6af4892d51a737c7e1df1bc59876bfd54419afae1437a711f7
- test/delivery-engine-router.test.js: c8a7947f996fb27b21bc3297168d8e702039445278e6d017674c299de96445fe
