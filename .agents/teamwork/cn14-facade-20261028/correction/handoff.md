# Correction composition source freeze

Status: bounded repair implemented, source frozen, independent review/challenge
pending. Authorized delta only src/concurrent-delivery-engine.js,
src/project-delivery-controller.js and their two tests. Source hashes in
source-final.json; four *.diff files compare against correction originals.
No Git mutation, live turns, service updates, dependency installs or auth routes.

Resume now drains pending owner corrections synchronously before changing pause
control revision. Controller exposes correction-only drain, checks owner generation,
and executes synchronous trusted onOwnerCorrection inside correction transaction
before applied acknowledgement. Async hook rejection, callback failure, checkpoint
registration/supersession failure or ack failure rolls back objective, current
inventory, checkpoint records/supersessions and events. Default hook is no-op for
standalone compatibility. Existing stale correction revisions are not rebased.

Engine hook registers deterministic replacements for all active prior checkpoints,
remaps dependencies, preserves mandatory check/environment/profile/critical pins,
then invokes existing authorized supersedeCheckpoints. checkpoint_ids_json is now
current owner inventory. Original goal/contract/intake digest/check contract and
historical checkpoint rows remain byte-equal. No validator relaxation or direct
checkpoint/receipt rewriting. Source authenticateOwner/ownerCorrectionAuthorized
still default deny.

Qualification: normal facade resume after direct SQLite reopen and recoverStoredRuns
both apply pending correction before resume. Repeated correction across a second
reopen preserves prior history and exact inbox replay. Old planner outputs retained
stale, next planner receives corrected goal/digest/control, independent verifier
with actual frozen candidate check qualifies acceptance on corrected pins. Old
admitted worker contract/control/fence/claim remain untouched; completion lawfully
settles publication_authorization_changed/not_published, retaining report/private
bytes and shared tree unchanged. Paused active worker projection refuses release.

Verification, each prefixed env -u NODE_TEST_CONTEXT:
- node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner correction facade' test/concurrent-delivery-engine.test.js
  Before repair final-qualification.log: 3 tests,1 pass/2 fail. current-pins-repro.log
  identifies stale checkpoint closure; resume-first-repro.log stale pending control.
- node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' --test-name-pattern='owner correction facade|correction trusted hook|correction-only drain' test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js
  repeated-correction.log: 10 pass/0 fail (before added old-worker fixture).
- node --test --test-name-pattern='owner correction facade preserves admitted worker' test/concurrent-delivery-engine.test.js
  old-worker.log: 1 pass/0 fail.
- node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js test/candidate-review.test.js test/delivery-lifecycle.test.js
  scoped-related.log: 92 tests/92 pass/0 fail/0 skip/0 canceled,42.7s. Final inputs.
- git diff --check -- src/concurrent-delivery-engine.js src/project-delivery-controller.js test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js
  Pass; all four files ASCII. No broad/full run; prohibited test never executed.

Remaining shutdown integration evidence, NOT fixed or accepted here:
- node --test .agents/teamwork/cn14-facade-20261028/correction/shutdown-worker-repro.cjs
  shutdown-worker-repro.log: 1 test/0 pass/1 fail after12.3s. This extends corrected
  admitted worker pause scenario with unsafe engine.shutdown while worker remains
  live, terminal drain, then fresh facade resume. Attempt becomes unknown, intent
  stays submitted, scheduler parks delivery_role_terminal_identity_unavailable.
  Executor result_adapter_failed evidence repeats that code. Host terminal report
  and private bytes remain, active claim unreleased. No unsafe release observed.
  shutdown-worker-case.cjs is the readable minimal scenario; bootstrap reuses current
  test harness definitions. This combination is separate pending recovery work.
  Root explicitly requested retained evidence and forbade source expansion.

Earlier repair-first.log also exposed invalid verifier mock (no checks); final
fixture executes frozen verify-source.js and supplies declared evidence. An expected
hook error-code typo was corrected. Intermediate failures are not pass evidence.
Ignored scratch may disappear. Next: independent review/challenge on frozen hashes;
root owns integrated verification and remaining correction+shutdown qualification.
