# Runtime evidence: serial review and repair churn

Read-only analysis of `.runtime/projects/c65886082e/state.sqlite` and the older
`.runtime/projects/c8740b5b4f/state.sqlite`. SQLite connections used
`mode=ro`. I read structured A2A input envelopes, reports, and staging metadata;
I did not inspect rollout transcripts or raw free-text conversations. No tests
or runtime changes were made.

## Concrete remaining source defect

`src/loop-guard.js:176-185` clears every checkpoint/role/target recurrence
counter when any observation in a settled batch has `implemented === true`.
The comment assumes that any integrated write moved the target. This is too
broad: unrelated writes can erase a recurrence for a still-identical review
target.

The saved c658 run shows this pattern. Checkpoint
`CP-M1-SUPERVISED-COMPLETION-001` reviewed four paths under
`harness/orchestrator`, `tests/orchestrator`, plus two docs paths. The same
target identity was reviewed by verifier at rounds 163, 165, 166, 173, 174,
176, and 178. Review reasons include three invalid reports, one
`review_origin_stale`, and accepted results. Between those attempts, round 168
changed `tests/db/test_migrations.py` and `docs/plans/m1/brief-T3.4.md`; rounds
170-172 changed DB/lifecycle files and the same unrelated brief. These changed
paths do not overlap the checkpoint scope, so they should not clear its
unchanged-target recurrence. `src/lead-graph.js:3695-3715` already computes a
content identity from review paths, but `advanceRecurrence` does not use it to
scope implementation resets.

The current source is susceptible to this reset pattern. The saved run's
timestamps precede the current recurrence guard's baseline, so this report
does not claim that the guard caused the historical seven attempts; the task
runtime build hash is not available here. A focused regression should place an
unrelated integrated change between repeated failures on one unchanged target
and ensure that target still pauses at its existing threshold. A write that
changes that target should still start a fresh recurrence.

## Serial dispatch evidence

The c658 run has 273 actual task assignment envelopes across 261 rounds; 249
(91%) have `wave: null`, and only 24 specify a wave. Twelve rounds had multiple
assignments: three grouped two assignments in wave 1, while nine used wave 1
followed by wave 2. The older c874 run has 418 envelopes across 332 rounds;
325 (78%) have `wave: null`. It had 54 multi-assignment rounds, including 26
with two null-wave assignments, which the scheduler processes serially. This
confirms serial planning as a substantial historical bottleneck. It does not
show an execution scheduler defect: `src/lead-graph.js:3255-3261` only marks
unwaved batches parallel for all-read-only non-review work; explicit groups
are gated by `deps.parallelWriters` around lines 3352-3355. The latest prompt
guidance change that recommends same-wave disjoint independent writers is
therefore relevant; these saved envelopes predate it.

## Review and sandbox alternatives

The c658 checkpoint above kept the same target while reviewers failed to
produce acceptable reports, then passed. The older c874 checkpoint
`m4-r20-integrated-authority-persistence` had 11 auditor attempts on one target
across rounds 32-43: four execution failures, three failed/unrun-check reviews,
one missing verdict, two stale-origin results, and one accepted result. The
failed checks include `jq` and `rg`; the records do not establish that these
commands were unavailable or impossible, only that checks failed. Most churn
was blocked by real review evidence requirements, not changed scope.

The generated-file hypothesis is not confirmed by these saved runs. All 41
recorded before-continuation target checks across these runs reported
`currentTargetMatches: true`; stale review receipts were reported as
`review_origin_stale`, not a current content mismatch. Some Python check
records explicitly used `PYTHONDONTWRITEBYTECODE=1`. Source risk remains:
`src/review-policy.js:89-107` walks every descendant of a directory scope and
does not filter Git-ignored files. The saved metadata provides no evidence that
an ignored generated file changed a review identity in these incidents.

No changes or tests are requested by this evidence task. Findings are limited
to historical saved data and current source; no live session was resumed.
