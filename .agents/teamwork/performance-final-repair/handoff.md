# Performance final repair handoff

## Status

Second review correction complete in assigned source/test scope. No Git
mutation, service action, model call, account change, or target-project action.

## Current delta

- `launcher-ui/performance.js`: session token components, attempt count, and
  unattributed usage count now follow coverage-aware merge rules. Known snapshot
  counts stay with retained snapshot values. Complete attributable live coverage
  can refresh all token components/count; live data fills unknown components,
  missing attempt counts, and absent unattributed counts when the snapshot token aggregate is wholly unknown.
- `test/launcher-performance-ui.test.js`: the finite partial case asserts two
  persisted attempts remain with 12 tokens; unknown and complete-coverage cases
  assert the live/complete attempt count behavior.

## Verification

- `env -u NODE_TEST_CONTEXT node --test test/launcher-performance-ui.test.js`
  - 12 passed, 0 failed, 0 skipped.
- `env -u NODE_TEST_CONTEXT node --test test/launcher-performance.test.js test/performance-store.test.js test/usage-report.test.js test/usage-ledger.test.js`
  - 21 passed, 0 failed, 0 skipped.
- `node .agents/teamwork/ui-settings-challenge/probe-performance-overlay.js`
  - Passed; row retains 12 tokens and 100 ms, session total is 12.
- `node --check launcher-ui/performance.js`
  - Passed.
- `git diff --check -- launcher-ui/performance.js test/launcher-performance-ui.test.js`
  - Passed.

## Constraints and next action

Other pre-existing modified/untracked work remains untouched. The assigned
source files already contained broader predecessor changes. Ready for
independent re-review.
