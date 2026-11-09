# AD-03 durable blocker-window rescheduling

## Goal

Add a pin-checked operation to refresh a still-pending budget wait's blocker windows and next check time after authoritative account reads report that all eligible profiles remain blocked. This prevents due waits from spinning at a stale reset hint and preserves the updated schedule across restart.

## Verified context

- `BacklogStore.recordBudgetWait()` creates a wait only from `planning`/`executing`; `wakeBudgetWait()` wakes a due wait only after authoritative eligibility.
- `DeliveryLifecycle` schedules durable waits and has synchronous eligibility; do not change reset timestamps into availability proof.
- Existing explicit blocker shape and validation are in `src/backlog-store.js`; prior store/lifecycle handoffs are under `durable-wait/`.
- Cwd `/home/sr/Projects/Workspace/codex-agent-control-plane`, HEAD `435afa3` plus active edits. Do not change Git state or touch `:memory:.lockdb`.

## Ownership

Own only `src/backlog-store.js`, `src/delivery-lifecycle.js`, `test/backlog-store.test.js`, `test/delivery-lifecycle.test.js`, and this task directory. These files have no active owner. Preserve existing AD-03 and AD-04 edits.

## Contract

Add `BacklogStore.rescheduleBudgetWait(projectId, objectiveId, waitId, input)` with exact fields `nextWakeAt`, `blockers`, `expectedControlRevision`, and `expectedOwnerGeneration`. Only update a row that is still `waiting`, whose objective remains `waiting_budget`, whose lifecycle control cause is `budget_wait`, and whose stored/objective owner/control pins all match. Reuse the existing blocker normalization. Keep waitId/source/provider/model/reason/resume disposition immutable. Update `nextWakeAt`, blocker array, updatedAt and SQL row only with a compare-and-swap condition; stale updates fail closed. Accept only safe integer timestamps and validated 1..64 explicit blocker records.

Add `DeliveryLifecycle.rescheduleBudgetWait(waitId, { delayMs, blockers })`, validate a bounded positive delay, update the store using current lifecycle pins, clear any disabled state for this wait, and re-arm the lifecycle timer. A successful reschedule does not wake the objective.

## Acceptance

1. A still-pending wait can be updated with fresh blockers and future next check; SQLite reopen retains both.
2. Stale owner/control pins, woken/missing rows, wrong objective state, and malformed blockers fail without mutation.
3. Rescheduling does not wake, change objective disposition, or treat reset hints as proof.
4. Focused store/lifecycle tests cover success, persistence, stale CAS, and refusal paths.
5. Run `node --test test/backlog-store.test.js test/delivery-lifecycle.test.js` and `git diff --check`.

Write exact results to `handoff.md`. This remains a storage/lifecycle primitive, not complete AD-03 orchestration.
