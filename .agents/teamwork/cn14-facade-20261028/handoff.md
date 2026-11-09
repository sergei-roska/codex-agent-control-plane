# CN14 facade checkpoint

Status: bounded source milestones accepted; whole CN14/CN15 and final integrated
qualification remain incomplete. Successor: ../scheduler-rearm-20261028/handoff.md.
The scheduler repair below is historical context; read the successor for current status.

## Authorization and preservation

Root owned Git/docs. No staging/commit/push/restart/deploy/live provider trial,
account/settings/model changes, dependency installs or real target mutation.
All122 predecessor dirty/untracked files retained. Exactly ten inherited files
changed: four product modules and paired tests (backlog-store, codex-app-server,
concurrent-delivery-engine, project-delivery-controller), plus architecture
implementation-status.md and foundation-api.md. source-start.json/source-final.json
and preservation-final.json: no missing predecessor files, no unexpected changes,
ASCII pass. Scheduler source/tests unchanged, preserved originals in poll-rearm/.
Ignored scratch/probes/logs may disappear; tracked tests retain accepted regressions.

## Accepted bounded milestones and evidence

1. Honest paused facade result and legal reused/reopened resume without stopping
admitted calls or losing unknown-effect fences. worker65/65; independent APPROVE
7facade+35selected checks; challenger HOLDS3/3. worker/, review/review.md,
challenge/handoff.md. Correction subsequently changes resume ordering and was
independently re-reviewed in the combined checkpoint below.
2. Explicit provider-managed terminal cleanup receipt, original generation/child/
process revalidation across await. cleanup/brief.md and handoff.md; worker13focused,
AppServer123pass/2same baselinefail; independent APPROVE14focused+4direct probes at
review/cleanup-review.md. Scope does NOT prove arbitrary escaped processes gone,
confinement, noEffect or cooperative safe release. No release policy relaxation.
3. Trusted owner correction drains before resume increments controls; atomic
correction+checkpoint registration/current inventory/supersession+ack; immutable
original intake/history and mandatory current candidate-bound verifier checks.
correction/repair-brief.md, handoff.md, diffs/hashes. Worker92/92 related checks.
Initial independent REJECT preserved in review/correction-initial-reject.md: real
shutdown noEffect recovery requeued and resent an obsolete old-goal task. Fixed
with additive claim goal capture and stale goal/authority replan blocking. No new
production typed correction route; production auth/authorization remain deny.
4. Recovery-goal repair: recovery-goal/handoff.md, source.diff/test.diff. Worker88/88;
independent combined APPROVE in review/correction-review.md, 9store/executor +
11correction checks + real engine probe proving old task not resent and a distinct
explicitly planned goal2 task executes. Current proof fields and same-goal retries
unchanged; legacy missing capture allowed only at objective goal1, later goal blocks.
Readable actual probes and historical failure preserved in review/. Challenger
HOLDS2/2 mixed-goal batch and post-write acknowledgement rollback; scripts and
hashes in challenge/correction-handoff.md. No product drift after review/challenge.

## Final verification, not green

Commands:
python3 .agents/teamwork/cn14-facade-20261028/verify-frozen.py affected
python3 .agents/teamwork/cn14-facade-20261028/verify-frozen.py full
Both scripts unset NODE_TEST_CONTEXT and include exact prohibited-test skip below.
Affected748tests/746pass/2fail/0skip/0cancelled, no timeout/inputDrift. Same ordered
predecessor failures (AppServer enumeration overrides; selected skills provenance).
Full1906tests/1893pass/12fail/1skip/0cancelled, no timeout/inputDrift. All ten baseline
failure names retained; two extra observations: known intermittent launcher exitnull
and new direct-resume corrected-acceptance timeout. Exact results/logs in
verification-{affected,full}.{json,tap}; baseline-comparison.json records differences.
Do not claim a green suite or no new full failure names.

Isolated launcher case1/1: launcher-isolated.tap, no launcher changes or fix claim.
Isolated direct-resume case1/1 without changed input/timeout:
correction/full-failure-isolated.log. Passing isolation does not fix the observed
full failure. Final git diff --check and ASCII passed; only docs changed after test
freeze, product/test reviewed hashes retained.

## Concrete next action: scheduler lost polling timer

Read correction/final-full-diagnosis.md FIRST. Deterministic actual scheduler/store
probe: env -u NODE_TEST_CONTEXT node --test
.agents/teamwork/cn14-facade-20261028/correction/early-poll-repro.cjs
Result1test/0pass/1fail; readable probe and log retained. Deadline1200 callback1199
clears timer but does not rearm future nextPollAt; active claim remains, inFlight[]/
parked[], advancing clock to1200 does not poll. Explicit runOnce at due time polls.
This is a concrete inherited task-scheduler.js #schedulePoll defect, leading
explanation for full timeout, NOT proved historical causality (failed full diagnostic
lacks timer/nextPoll/role/executor evidence). Do not just increase timeout.

Next worker scope src/task-scheduler.js + test/task-scheduler.test.js: inspect and
repair early callback/future deadline rearming with deterministic regression. Do
not create busy poll loops for parked/unknown intents or stale nextPoll entries.
Scope needs a new brief/ownership; implementation and review are pending. Then independent review/targeted timer challenge,
affected/full checks on final frozen source. poll-rearm/ contains unchanged
originals only; not an implemented repair.

## Other pending requirements

Correction+unsafe shutdown+terminal drain+fresh resume still can park unknown
submitted attempt at delivery_role_terminal_identity_unavailable. Read
correction/shutdown-worker-case.cjs and shutdown-worker-repro.log. Claims/report/
private bytes retained, no unsafe release. Do not simply wire noEffect recovery into
resume or requeue old scope. Distinct broader terminal reconciliation remains.

Ordinary cooperative retry-close remains refused/unqualified. Decision review/
cooperative-decision.md and cooperative-context.md identify missing truthful
process coverage and distinct terminal outcome settlement. Provider-managed receipt
alone is NOT arbitrary detached-process proof; never force strict permissions or
call cooperative worktrees confined. Keep unknown provider/publication fences.

Then integrated CN14 acceptance and CN15 matched legacy/concurrent accepted-work
comparison and recoverable-failure-to-acceptance qualification. cn15-coverage.md is
source-only research, not PASS evidence. Real trial/backend upgrade requires
separate actual lifecycle authorization; current user continuation covered source
work only. No running backend was updated.

Every delivery-acceptance/full command MUST retain exact exclusion:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Never run that prohibited named test. All current verification retained it.
