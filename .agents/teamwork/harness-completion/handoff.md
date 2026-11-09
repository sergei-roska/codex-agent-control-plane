# HAR-02 recurrence reset repair

Status: focused implementation and regression verification complete.

Runtime evidence is recorded in `runtime-findings.md`. Current source bug was
confirmed at `src/loop-guard.js:176-185`: any integrated observation cleared
every checkpoint/role/target recurrence counter. Implemented recurrence state
now remains keyed by each target. An actual target identity change creates a
new key and starts a fresh count while retaining other target history. No
acceptance or evidence guard semantics changed.

Changed only `src/loop-guard.js` and `test/loop-guard.test.js`. Tests cover an
unchanged review failure across an unrelated integrated write and JSON state
round-trip, changed target starting at count one while prior target history
remains, and the existing unchanged-target threshold and writable-no-change
behavior.

Verification:

- `node --test --test-name-pattern='same checkpoint, role class, and target|unrelated implementation preserves recurrence history|changed target starts its own recurrence|writable dispatch that changed nothing|different target, checkpoint, or role class' test/loop-guard.test.js` - 5 passed, 0 failed.
- `node --check src/loop-guard.js` - passed.
- `git diff --check -- src/loop-guard.js test/loop-guard.test.js` - passed.

No live session, service, or runtime state was changed.

# Handoff

# Handoff

Status: source fix and focused regressions complete.

Verified finding HAR-02-1: `captureReviewRecoveryTemplates` in `src/lead-graph.js`
stores only reviewer role/scope/tool pins. `recoveryAssignment` then recreates
inputs, acceptance criteria, checks, and stop conditions from generic literals,
discarding the original execution brief on an automatic fresh verifier or
auditor. This matches the known blocked-check recurrence: exact retry guidance
is absent even though immutable review context is retained. Relevant code is
around lines 831-950. Existing review recovery keeps a bounded generation,
blocks at its generation limit, and requires current-target receipts; do not
weaken those gates.

Verified bounded retry: stale review recovery refuses another generation when
`entry.lastRecoveryTarget === current.identity` or the generation cap is hit
(`src/lead-graph.js` around lines 1285-1288). Finish decisions pass
`gateFailure(...forFinish)`; acceptance runs in `accept`, and `finish` enforces
review gates again. The loop guard warns after three matching work/evidence
rounds and pauses on a further unchanged recurrence; checkpoint/role recurrence
pauses on the third unchanged target review. I found no separate convergence
defect in these paths; existing bounded behavior is now covered directly for
the unchanged stale-review target.

Implemented: recovery templates now retain the original bounded assignment
brief (objective, inputs, evidence, acceptance criteria, checks, and stop
conditions). New templates validate each field against assignment limits;
legacy checkpoint templates without the added brief remain valid and retain
their preexisting fallback behavior. Recovery still refreshes the marker
generation and copies the immutable review context from the obligation.

Focused regressions in `test/lead-graph.test.js` verify the original verifier
brief survives automatic stale-auditor recovery and a repeated stale target
blocks without another reviewer submission. Exact verification:

- `node --test --test-name-pattern='a stale usage-limited auditor recovers before another lead decision|a stale continuation is not retried again when the recovery target is unchanged' test/lead-graph.test.js` - 2 passed, 0 failed.
- `node --check src/lead-graph.js` - passed.
- `git diff --check` - passed.

Parallel worker shares `src/lead-graph.js` and `test/lead-graph.test.js` but
owns only the prepare/dispatch and wave prompt regions. Its concurrent diff is
visible in those files; preserve it. This worker changed only recovery helper
code near lines 790-965 and tests near the stale-review cases around lines
3960 and 4665. No live state, service, session, or target project was changed.
