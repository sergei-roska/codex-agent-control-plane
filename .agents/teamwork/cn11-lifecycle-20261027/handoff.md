# CN-11 handoff

## Ownership and constraints

- Root owns Git and tracked docs. CN-13 owns launcher/UI/visibility paths.
- CN-11 owns `src/delivery-lifecycle.js`, its tests, controller source/tests,
  and the explicitly granted TaskExecutor recovery source/tests.
- Root temporarily returned `src/backlog-store.js` and its tests for the narrow
  scoped retry/recovery correction. That correction is now frozen and ownership
  is handed back to root/CN-12. Do not edit either store file without renewed
  coordination.
- Preserve predecessor changes captured in
  `.agents/teamwork/lifecycle-continuation-20261027/source-start.json`.
- No live providers/models, services, account operations, target edits, or Git
  mutation were used.

## Stable lifecycle and controller APIs

- `DeliveryLifecycle` is fixed to project/objective/owner-generation/control
  pins. It exposes pause/stop/resume/cancel, budget waits, scoped retries,
  recovery, planner reconciliation, projections, and `shutdownProjection()`.
- `recordBudgetWait()` requires bounded source/provider/model/reason and delay.
  `wakeBudget()` only resumes after due time, unchanged pins, and synchronous
  literal-true `budgetWakeEligibility`.
- `recordTransientFailure()` requires retry `scopeType` and `scopeId`. Planner
  validation retries use objective scope; task errors use task scope. Non-planner
  due retries go to injected `onRetryDue` and do not wake the lead model.
- Planner validation recovery requires a returned output, allowlisted pure
  validation error, and exact synchronous process/remote quiescence proof.
  Thrown provider errors remain held. The next turn retires the old unknown turn
  only through the public `reconcilePriorTurn` delegate returning an exact
  no-effect proof.
- `finalizeBlockedPlannerRecovery()` blocks the objective only after all live
  claims and potentially progress-capable tasks are gone. The controller then
  drains siblings and suppresses repeat planner calls for the same control
  revision.
- `ProjectDeliveryController.start()` refuses to adopt control drift. Its
  `shutdown({ pause })` returns the public drain projection; unknown admission
  or unproven effect settlement is unsafe to release.
- `TaskExecutor.recover(identity)` releases only after an exact synchronous
  no-effect proof matching attempt, claim, context, intent, fencing token, and
  recovery generation. Missing or uncertain proof retains capacity.

## Frozen BacklogStore correction

- `recordLifecycleRetry()` now requires bounded `scopeType`/`scopeId`, validates
  objective/task/checkpoint references, enforces planner validation at objective
  scope and executor errors at task scope, and counts strategies per scope.
- `blockLifecycleRetry()` durably closes an exhausted retry scope.
  `blockTechnicalIfNoProgress()` sets objective `blocked_technical` only when
  no live claims or progress-capable pending tasks remain.
- Exhausted local retries retain task-local blocked state while ready siblings
  remain claimable. `settleRecoveredNoEffect()` now returns `task_blocked` and
  emits `attempt.recovery_task_blocked` when the affected task exhausts recovery
  while siblings can progress; objective block occurs only after progress ends.
- Existing no-effect proof matching, claim release, settings/thread pins,
  cancellation semantics, and event transaction boundaries remain in place.

## Verification

Command:

```text
node --check src/backlog-store.js && env -u NODE_TEST_CONTEXT node --test test/backlog-store.test.js test/delivery-lifecycle.test.js test/task-executor.test.js test/project-delivery-controller.test.js
```

Result: 98/98 passed. This includes independent task retry scopes, a ready
sibling after task retry/recovery exhaustion, due retry restoration after SQLite
reopen, submitted-intent polling without resend after generation takeover,
uncertain intent retention without proof, late success normalized to canceled,
pause drain versus emergency stop, planner validation proof versus thrown
failure, and finite planner retries without an idle model loop.

The earlier store-only verification was 34/34 before the final combined run.

## Shutdown race correction

- `ProjectDeliveryController.shutdown()` latches shutdown and advances the run
  generation. Queued microtasks and entered cycles check the captured generation
  before planner admission and after each await. Manual `runOnce()` remains valid
  before shutdown, and is blocked after shutdown.
- The controller wraps its planner and scheduler admission methods so direct
  calls cannot start new work after shutdown. A planner already in flight gets
  an inbox-version bump, making its later output stale inside the planner's
  transaction; its reservation remains active until the turn settles.
- `DeliveryLifecycle.shutdownProjection()` reports
  `controller_cycle_in_flight` while a controller cycle or scheduler run is
  active. The projection stays unsafe until that work drains or durable claims,
  planner turns, inbox messages, and publication facts prove otherwise.
- Deterministic tests cover shutdown between `runOnce()` entry and planner
  admission, a held planner turn whose output must not apply, and queued/direct
  planner and scheduler calls after shutdown. Existing pause-drain and manual
  pre-start `runOnce()` cases remain covered.

Store ownership remains with root/CN-12; no store edits were made for this fix.

## Root/CN-12 next action

Store source/test ownership is returned to root/CN-12 for additive finalization.
CN-11-owned lifecycle/controller/executor files are ready for independent risk
review and targeted probes. Do not stage or commit from this task.
