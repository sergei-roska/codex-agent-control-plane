# Current state: autonomous delivery backlog AD-01..AD-08 complete

Date: 2026-11-06. Owner: root. Work started from baseline HEAD ab5c195 and was
committed as 435afa3. Status: complete; AD-01 through AD-08 are accepted. The
inherited untracked :memory:.lockdb
remains untouched.
Owner objective: complete the full active autonomous delivery backlog
AD-01..AD-08. Backlog reset is independently APPROVED. AD-01 objective binding,
concurrent restart, A2A worker-call identity, and lead-planner call binding are
implemented and independently reviewed. AD-01 through AD-08 are complete for
the functional qualification scope.
Existing-profile re-login and auth
pause/wake integration are implemented. The first AD-02 review's two rollback
races have been repaired. Delta review found `server.js` dropped the expected
selection revision and profile CAS was not serialized across processes. The
profile-store lock repair passed focused suites 101/101 and Sol approved it.
Root now forwards the pin through the production adapter; composed budget and
auth owner-selection regressions pass. Latest watcher/failover suites pass
43/43 and named real-server race cases pass 4/4. Sol approved the adapter and
active-auth-candidate race repairs. AD-03 now stores bounded, hashed per-account
blocker windows and wires trusted usage-limit evidence, authoritative
eligibility, controller rescheduling, project-wide quiescence, journaled provider
rebind, and server startup recovery. Focused engine, wrapper, server composition,
store, lifecycle, role-service, and blocker suites pass. SQLite close/reopen
through a new engine and startup recovery passes. Real startServer profile
composition and close/reopen wait recovery both pass. Independent AD-03 review
found no actionable defects; see [AD-03 handoff](AD-03-account-wait-20261106/handoff.md).
AD-04 recovery-cap and stale-fixture changes pass the full lead-graph file
288/288 and focused transient/restart/migration suites. Sol's delta review
approved the scheduled-retry and legacy-question migration repairs. A follow-up
review found and confirmed a production router delegation gap; the router-aware
migration fix passed focused tests and Sol's delta review. The full server suite
remains incomplete after a pending-promise stall; see the
[AD-04 handoff](AD-04-recovery-20261106/handoff.md) and
[review](AD-04-recovery-20261106/review/handoff.md). The implemented backlog
foundations and handoffs were committed in 435afa3. Inherited untracked
:memory:.lockdb remains untouched; no runtime
activation or live provider run.

## Active development direction

Use docs/autonomous-delivery-backlog.md for new work. Eight AD tasks cover durable
objective identity, two-account failover, durable all-window wait/reset/restart
resume, technical recovery and substantiated owner questions, effect/control
reconciliation, honest acceptance, chat steering/status and integrated qualification.
Every restriction needs owner intent, a provider fact or an evidenced invariant.
Counters alone cannot manufacture owner questions, success or terminal partials.

## Acceptance and evidence

Old plans archived in place; original bodies, package data, graph facts and open
work retained. Migration: docs/autonomous-delivery-migration.md. Source findings:
docs/autonomous-delivery-constraints.md. Existing trial authorization preserved.
Independent critic APPROVE; 112 doc/link/path/archive/ASCII/JSON checks; DAG and
38 open/pending ID-family mapping checked. No runtime readiness claim.

Current handoff: [backlog-reset-20261106/handoff.md](backlog-reset-20261106/handoff.md).
Review: [review/handoff.md](backlog-reset-20261106/review/handoff.md).
Workers: [backlog](backlog-reset-20261106/backlog/handoff.md),
[constraints](backlog-reset-20261106/constraints/handoff.md).
Previous project map: [previous-project.md](backlog-reset-20261106/previous-project.md).
Previous incomplete trial: [closeout handoff](closeout-20261105/handoff.md).

## Active work

AD-01 contract and evidence: [planning package](AD-01-planning-20261106/).
The legacy path pins project, workspace, task, and acceptance contract before
dispatch; `node --test test/e2e.test.js` passed 12/12. Concurrent composed
router/engine restart coverage passed 67/67. A2A worker calls now persist a
hashed configured account identity at the selected provider-call boundary;
and lead-planner calls have separate durable coordinator attempts. Independent
review approved the fail-closed call boundary; lead-graph passed 284/284,
worker e2e passed 13/13, and app-switch plus durable-store passed 32/32.
AD-01 is complete: same-home credential replacement has a tested generation
fence, Sol approved the profile-switch starvation fix, and objective/check
lineage and provider rebind survive their focused restart tests. See
[same-home handoff](AD-01-planning-20261106/same-home-rotation/handoff.md) and
[review](AD-01-planning-20261106/same-home-rotation/review-handoff.md).
AD-02 settled legacy two-account transfer is independently approved, and the
unsettled-attempt transfer regression passed 51/51 with its focused suites.
Existing-profile browser/device re-login preserves the same home, requires
explicit restored auth state, and passed 29/29 launcher-account tests, including
typed 401/403 classification and unrelated-error unknown state. Auth
pause/failover/auto-resume integration and the initial CAS/wrapper repair
passed focused suites. Sol found the production adapter did not forward the
selection pin and the CAS was not cross-process atomic. Cross-process
serialization is independently approved; the production adapter now forwards
the pin. A follow-up review found the active auth candidate bypassed selection
validation after its availability read; that path now uses the conditional
wrapper and has unit plus real-server regressions. Focused account suites pass
101/101, watcher/failover suites 43/43, and named server race cases 4/4. Sol
approved the adapter and active-auth-candidate delta. Automatic all-window wait
and provider rebind remain AD-03 integration work. Explicit auth-state findings
are in [auth research](AD-02-account-transfer-20261106/auth-research/); the
re-login implementation handoff is at
[profile re-login](AD-02-account-transfer-20261106/profile-relogin/). The
unsettled-attempt coverage is at
[remaining coverage](AD-02-account-transfer-20261106/remaining-coverage/).
AD-04 recovery-cap and stale-fixture changes passed the full lead-graph file
288/288. The transient cap now has a scheduled next action across restart, and
persisted threshold-only owner prompts migrate into technical replanning while
preserving genuine owner-only decisions. Sol approved the repaired delta,
including the production router composition fix. The full server suite remains
incomplete after a pending-promise stall; focused migration and router suites
pass. See its [handoff](AD-04-recovery-20261106/handoff.md) and
[review](AD-04-recovery-20261106/review/delta-fix-handoff.md).
AD-05 concurrent cancellation/reconciliation was independently approved after
the same-generation no-intent retry fix; its suites pass 160/160. The legacy
budget watcher rechecks entry identity after awaited switching. Real server
cancellation remains terminal across restart, and authenticated concurrent
pause/cancel host routes win against late budget eligibility without waking,
switching accounts, or admitting another attempt. Named legacy server
race/restart cases passed 2/2, the watcher suite 45/45, and the composed
control-race suite 3/3. See
[AD-05](AD-05-control-reconciliation-20261106/).
AD-03 durable wait storage accepts up to 64 explicit blocker windows per wait,
including hashed account identity, model/window/reason and reset hint. Wake
requires explicit provider availability, explicit auth clearance, and matching
owner/control pins. Concurrent eligibility, controller rescheduling, journaled
project-wide rebind, server adapter wiring and startup recovery are implemented.
Full concurrent engine passed 68/68, including explicit-auth unknown-state and
SQLite close/reopen recovery; wrapper passed 23/23, relevant
store/lifecycle/role/blocker/journal suites passed 176/176, and real server
composition plus close/reopen recovery passed 2/2. Independent delta review
found no actionable defects. AD-03 is complete. See
[AD-03 handoff](AD-03-account-wait-20261106/handoff.md).
Sol approved the project-wide admission-barrier design; see
[architecture consultation](AD-03-account-wait-20261106/rebind-architecture.md).
AD-06 acceptance/store tests passed 134/134 and independent
acceptance review approved; see [AD-06 implementation](AD-06-acceptance-20261106/implementation/handoff.md)
and [review](AD-06-acceptance-20261106/review/handoff.md). AD-07 LL-7 browser
acceptance passed 1/1 and durable status projection is implemented.
Revision-pinned pause/resume/cancel host and launcher controls plus UI passed
16/16 focused tests; a real engine cancel-drain test passed, the combined
control/reconciliation suites passed 177/177, and browser acceptance passed
1/1. The composed quota/account pause/cancel race passed 3/3. See [status
handoff](AD-07-research-20261106/status-projection/handoff.md) and [pause
controls](AD-07-research-20261106/pause-controls/handoff.md).
AD-08's real-server deterministic release scenario passed A/B exhaustion,
durable waiting across close/reopen, automatic recovery, and acceptance of the
same objective and pinned verifier check. The full concurrent engine suite
passed 72/72; composed release/control/auth qualification passed 5/5. Focused
failure cases preserve honest nonaccepted states, and a separate existing-
profile login test proves automatic legacy auth recovery. Independent Luna
review APPROVED the AD-08 delta. See [integrated release](AD-08-integrated-release/handoff.md),
[restart driver](AD-08-restart-driver/handoff.md), [control races](AD-08-control-races/handoff.md),
and [auth recovery](AD-08-auth-recovery/handoff.md).
No runtime activation, live provider call, or real quota use occurred. The
inherited untracked :memory:.lockdb remains untouched.

## Model routing for this work

Luna remains lead and owns scope, assignment, integration, and acceptance. Use
Luna for execution, research, testing, and orchestration. Select Terra for the
nature of a narrow specialist task, not as an automatic promotion after a Luna
obstacle. Consult Sol for architectural/deep-analysis questions when justified;
Sol returns a recommendation to Luna and does not take over the team.

## Completion

The AD-01..AD-08 functional backlog and required deterministic qualification
are complete. No backlog implementation or verification action remains.
Runtime activation and live-provider validation were outside this task and were
not performed. Preserve the inherited untracked :memory:.lockdb and do not
stage or commit these changes.
