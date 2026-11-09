# Pause/resume facade source freeze

Status: implementation complete, awaiting independent review. Source frozen after
65/65 focused checks. Only src/concurrent-delivery-engine.js and
test/concurrent-delivery-engine.test.js changed. No scheduler/controller changes,
Git mutation, live provider turns, external actions or running service updates.

Engine wait returns input_required with pause.kind owner_pause when durable
objective disposition is paused_owner. It keeps the admitted controller, planner,
scheduler and worker calls alive. Resume uses existing controller.resumeObjective
for legal owner_pause/owner_stop in paused_owner; missing/shutdown controller uses
the existing store transition. Technical/budget waits are never blanket resumed.
Removed redundant pre-construction fence deletion; #controller retains its existing
fence handling. Historical canceled behavior and shutdown recovery unchanged.

Seven regressions cover reused/reopened SQLite controllers, pending admitted planner,
repeated resume, second pause, worker completion, unknown worker effects, owner stop
with unknown planner, and technical/budget boundaries. Old planner output is retained
stale; resumed planner output is retained complete. Worker completion after changed
controls correctly settles failed/publication_authorization_changed/not_published;
private report/bytes survive. This is expected publication refusal, not completion
loss. Unknown effects retain claims and unsafe shutdown refusal. No scheduler defect
found; scheduler scope expansion was not used.

Verification (all commands prefixed env -u NODE_TEST_CONTEXT):
- node --test --test-name-pattern='scratch pause and resume facade observation' .agents/teamwork/cn14-core-followup-20261027b/facade-probes.cjs
  1/1 passes reproducing old defects; repro.log records facadeSettled false and
  resume disposition paused_owner.
- node --test --test-name-pattern='owner pause facade' test/concurrent-delivery-engine.test.js
  Before source repair: regression-before.log, 0 pass/2 fail at missing paused return.
  Final: focused.log, 7 pass/0 fail.
- node --test test/concurrent-delivery-engine.test.js test/project-delivery-controller.test.js test/delivery-lifecycle.test.js test/delivery-host-controls.test.js
  engine-controller-lifecycle-host.log: 65 pass/0 fail/0 skip/0 canceled, 39.2s.
- git diff --check -- src/concurrent-delivery-engine.js test/concurrent-delivery-engine.test.js
  Pass. Both files ASCII.

No affected/full/delivery-acceptance command run. Mandatory prohibited-test skip
still applies to any such later command. Baseline affected 715 pass/2 fail remains
inherited, not requalified here. Intermediate debug logs include fixture expectation
failures and two stopped test processes from incomplete fixture setup; those are not
success evidence. Final checks have no asynchronous post-test failures.

Exact hashes: source-final.json. Narrow diffs against parent-provided originals:
concurrent-delivery-engine.js.diff and concurrent-delivery-engine.test.js.diff.
Ignored scratch evidence may disappear. Owner correction and cooperative retry-close
remain separate, untouched. Next: root independent review and race challenge.
