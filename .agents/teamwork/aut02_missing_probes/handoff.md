# AUT-02 missing probes handoff

Q04 probes added in `test/lead-graph.test.js`:
- Stable routine review scope continuation is sent with the exact six-field review context and reaches the App Server; no recovery is queued.
- Changed-target scope continuation is rejected after graph preflight and recovered; service inputs preserve the exact review object on all four sends, with no stale continuation model call.

Q11 owner-pause probe: request pause after the actual stale direct-service response reaches failed terminal state. The run parks before recovery selection; the checkpoint generation remains zero, no recovery event or pending assignment is created, and only the initial worker model call occurs.

Existing focused controls retained: stale usage-limited auditor changed-target skip and recovery (`a usage-limited auditor cannot continue across a changed target...`, `a stale usage-limited auditor recovers before another lead decision`); recovery verifier usage-limit/restart (`a usage-limited recovery verifier keeps its generation through restart before auditor dispatch`); generation exhaustion prompt/state (`a blocked recovery reason survives restart beside the complete review context`); generic unresolved-writer admission (`unproven quiescence pauses...`, `reconcile precedes decide...`); generic cancellation (`an explicit cancel (no stop reason) still ends the run as canceled`). These generic lifecycle controls do not inject cancellation or unresolved-writer state at the recovery-selection boundary. No additional probe was added because the assigned Q11 addition is covered by the owner-pause admission case and the existing focused budget/retry controls.

Verification:
- `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='a stable review scope continuation keeps its origin|a direct-service origin that goes stale after graph preflight recovers automatically|owner pause parks before recovery selection after a stale scope continuation rejection' test/lead-graph.test.js` - 3 pass, 0 fail, 0 skip.
- `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='a stable review scope continuation keeps its origin|a direct-service origin that goes stale after graph preflight recovers automatically|owner pause blocks fresh review recovery after a stale scope continuation rejection|a usage-limited auditor cannot continue across a changed target and a fresh audit is dispatched|a stale usage-limited auditor recovers before another lead decision' test/lead-graph.test.js` - 5 pass, 0 fail, 0 skip (run before the owner-pause test title was clarified).
- `git diff --check -- test/lead-graph.test.js` - pass.

No product source, other tests, fixtures, docs/evidence, or Git state changed by this task.
