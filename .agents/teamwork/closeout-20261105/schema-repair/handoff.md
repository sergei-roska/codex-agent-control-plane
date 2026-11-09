# Planner supersession schema repair handoff

Status: implementation complete; scoped verification passed; critic review pending. Source and tests are frozen for review.

Owned source delta is limited to `src/concurrent-delivery-engine.js`: the prompt now distinguishes ordinary create, exact-revision update with preserved lineage, and distinct superseding create that carries the old task's current revision and retains failed-attempt history. Strict output branches require `supersedesTaskId: null` for ordinary creates, pin existing lineage for updates, and pin the exact eligible supersession target for new revision-1 tasks. Existing eligible roles/states and host publication gates are unchanged.

Added native-schema regression in `test/server-delivery-engine.test.js`. It seeds a real failed attempt through `BacklogStore`, checks the generated schema is strict and encodes the target/revision pair, applies the proposed delta through `validatePlanDelta` and `BacklogStore.applyPlan`, and verifies the failed task becomes superseded while its attempt stays unchanged. The test also checks stale, missing/foreign, active, terminal, same-ID, and lineage mutations. Existing create/update and prompt tests remain meaningful.

Baseline regression evidence: `node --test --test-name-pattern='planner schema represents a distinct repair superseding a failed task' test/server-delivery-engine.test.js` failed 0/1 before source edits at the missing exact target branch assertion. The first fixture attempt instead hit `selected_settings_conflict` because runtime settings were already pinned; removing the redundant test setup pin exposed the intended baseline failure.

Final verification:

- `node --test --test-name-pattern='planner sends a strict usable schema|planner schema represents a distinct repair superseding a failed task' test/server-delivery-engine.test.js` - 2 passed, 0 failed.
- `node --test test/server-delivery-engine.test.js` - 82 passed, 0 failed.
- `node --test test/delivery-contracts.test.js` - 16 passed, 0 failed.
- `node --test test/concurrent-recovery-acceptance.test.js` - 1 passed, 0 failed; V43 failure history remained unchanged.
- `node --test test/lead-planner.test.js` - 11 passed, 0 failed.

No model tasks, runtime restarts, validator edits, or Git mutations. Root owns broad suite, critic acceptance, final Git review, and any live-dispatch decision.
