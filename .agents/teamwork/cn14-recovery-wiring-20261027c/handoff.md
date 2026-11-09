# Recovery wiring accepted checkpoint

Updated2026-10-27T22:01Z (2026-10-28 local). Status: bounded source milestone
accepted; whole CN14/CN15 remain pending. Running server was not changed.
Root owned Git/docs; no staging/commit/restart/live trial, account/settings/model
changes or discarded predecessor work. HEAD65a970e. Baseline122 individual dirty/
untracked files in source-start.json; all preserved. No additional tasks started.

## Accepted delta

Only product files src/concurrent-delivery-engine.js and
 test/concurrent-delivery-engine.test.js changed. Root updated tracked
 docs/architecture/concurrent-harness/implementation-status.md after tests.
Originals, exact deltas and final source hashes: worker/.

Engine now delegates TaskExecutor recoveryProofAdapter to the accepted RoleService
recoveryProofFor. Shutdown fences every existing controller before awaiting any
cycle/scheduler, drains actual local role calls, then scans all durable runs,
including canceled runs without a controller. For exact nonterminal attempts it
calls prepareNoPublicationRecovery, then requestLifecycleRecovery/executor.recover.
No direct claim writes, new providers/controllers or owner permission changes.
Existing lifecycle projection still authorizes release from durable facts.

Six real HTTP tests use fake providers/disposable Git/SQLite: owned-worktree lost
acknowledgement safe retry shutdown; cooperative refusal; unknown provider refusal;
unknown publication refusal; pending inbox refusal after honest claim settlement;
canceled SQLite reopen recovery without a controller. Safe shutdown is idempotent,
private bytes retained, shared tree unchanged, no new provider calls/publication.
The inherited ordinary cooperative host safe retry-close remains refused/unqualified.
Do not claim the default cooperative production scenario is fixed.

## Review and challenge

review/review.md: independent APPROVE,23/23 focused tests and unchanged trusted
identity/fence/generation/publication validation. Worker initial4suite91/91 used
prior equivalent test teardown hook ordering; final affected run covers final inputs.
challenge/handoff.md: HOLDS on two real probes, multi-controller early-unsafe fencing
and provider identity drift during awaited lane cleanup. Mixed prepared/unknown
siblings and generation drift not separately exercised; reviewer inspected these
safety paths but did not claim runtime coverage.

Initial final affected run timed out180s in host cleanup, inputDrift[]. Diagnosis:
global drain polled durable unknown rows with active0/controllers0/storedRuns0 for5s,
matching host's5s shutdown bound; fixture cleanup failed and left its HTTP process.
Evidence worker/{host-drain-instrumented.log,durable-drain-before.log}.
Scoped repair waits on roleService.active.size, never uses it as release evidence.
A deterministic no20ms-waits regression failed before repair and passes after;
unknown effects still refuse shutdown. review/drain-rereview.md APPROVE,1/1 on
final hashes. Host formerly failing case now199ms; final engine+host74/74.
Lead reran both challenge probes on final repaired source,2/2:
challenge/final-repair-recheck.log. No changes after frozen final source checks.
Worker stopped two redundant test commands; their partial logs are not success.

## Final verification

Command: python3 .agents/teamwork/cn14-recovery-wiring-20261027c/verify-frozen.py affected
Result717tests,715pass,2fail,0skip,0cancelled; duration38.1s, inputDrift[], no timeout.
Failures exactly match predecessor ordered affected failures (baseline-comparison.json):
- enumeration failure still sends apps/plugins/skills overrides and marks enforced false
- selected skills are explicit turn inputs with scoped boundary and hash provenance

Evidence verification-affected.{json,tap}. Initial timeout preserved separately as
verification-affected-initial-timeout.{json,tap}; it also observed launcher
'launcher becomes ready on a free port and shuts down cleanly' exitnull failure.
Isolated launcher case1/1 and final affected case passed, no launcher changes.
This intermittent signal-exit failure is not claimed fixed or a new accepted baseline.
Full suite NOT rerun for this bounded milestone; retained predecessor1869tests,
1858pass,10fail,1skip. Do not claim suites green or whole CN14 accepted.

Every delivery-acceptance/full command MUST retain exact prohibited-test exclusion:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
The historically prohibited hostile Git-filter test was never run this turn.
Node CommonJS; env -u NODE_TEST_CONTEXT. Test services disposable only.
Ignored scratch/probe/log evidence may disappear; tracked regressions retain core
behavior. No secrets/private conversations in coordination files.

## Next action

1. Pause/resume facade: predecessor scratch cn14-core-followup-20261027b/facade-probes.cjs
reproduces paused_owner run promise not returning and reused controller resume
remaining paused. Fix honest paused return and control transition without dropping
active work. Assign new worker ownership; current worker/reviewer/challenger done.
2. Owner correction: objective goalRevision/digest increments but concurrent run
requirement_digest remains stale. Synchronize trusted current pins while preserving
historical intake/mapping and active old attempt fences; qualify correction/reopen.
3. Ordinary cooperative retry-close requires truthful no-effect evidence. Never
force strict owner policy or call cooperative worktrees confinement. Publication
uncertainty always stays fenced. Existing source API intentionally refuses it.
4. Complete full integrated CN14 facade qualification/review/checks, then CN15.
Separate authorization still needed for a real trial or running service upgrade.
Do not restart/deploy/run real targets from this handoff alone.

## Quota

Read fresh via read-quota.py before dispatch. Current profile /home/sr/codex-work,
NOT predecessor /home/sr/codex-home. Latest22:02:12Z primary83%used,weekly86%used.
Old profile does not describe this session. At90%primary used start no new tasks
or agent turns; finish collection/checkpoint. No Astra.

Final preservation: git diff --check, ASCII and status-doc local links passed.
source-final.json hashes122 files; preservation-final.json confirms no inherited
file missing and no code drift after final review/verification. Only expected
engine source/test and durable status doc differ from turn start.
