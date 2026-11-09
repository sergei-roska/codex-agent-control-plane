# CN-08 task scheduler handoff

Status: critic/challenge repairs complete; frozen for final independent re-review.

## Verified predecessor APIs

BacklogStore exports `claimReady(projectId, objectiveId, schedulerGeneration,
{ leaseMs, limit, controlRevision })`, `projectBacklog`, `getObjective`,
`projectCapacity`, `listClaims`, and `listAttempts`. Claim selection and
dependency/control/capacity checks run in `db.transaction(...).immediate()`.
It returns `{ task, attempt, claim }`.

TaskExecutor exports `execute(identity)`, `reconcile(identity)`, `poll(identity)`,
`acceptTerminal(identity, remote)`, and `getAttempt(attemptId)`. `execute` may
return `submitted` while durable capacity remains held.

## Implemented API and decisions

`BacklogStore.claimReady` accepts optional `canClaim(candidate, liveEntries)`.
The callback runs inside the immediate claim transaction after persisted
readiness and capacity checks. `candidate` is the candidate task snapshot;
`liveEntries` is a project-wide array of `{ claim, attempt, task }`, including
claims created earlier in the same batch. Both inputs are deep-cloned and
deep-frozen. It must return a strict boolean synchronously; false skips a task,
and promises/non-booleans throw and roll back. Omission preserves old behavior.

`TaskScheduler` options are `{ store, executor, projectId, objectiveId,
controllerIdentity, roles, roleLimits, writerMode, leaseMs, pollIntervalMs,
maxActiveTurns, plannerReservedSlots, isFrozenReview, admissionPolicy, now }`.
Methods are `start()`, `wake()`, `runOnce()`, `stop()`, and `projection()`.
It treats executor `submitted` as live, polls independently, recovers existing
intents by poll/reconcile, only starts an un-intented claimed attempt through
`execute`, parks unknown/error attempts, and coalesces wakeups while a pass runs.
The admission callback adds restrictions after built-in scope checks and cannot
override resource conflicts.

Eligibility no longer uses a first-page backlog projection as a gate. Every
claim pass delegates to the store's full ready scan and synchronous atomic
predicate; only dependency-idle classification pages queued/ready tasks to the
end. During pause/control drift, existing intents continue poll/reconciliation,
while claimed attempts without an executor intent remain unstarted.

`resourceConflict(candidate, liveEntries, { writerMode, isFrozenReview })`
compares exact/subtree product paths, declared read scope, dependencies, and
exclusive `resourceClaims`. Shared mode serializes product writers. Unknown
read scope conflicts conservatively. Critical audit/review work waits for live
writers unless the injected frozen-review predicate returns strict true; the
default never grants that proof. Scratch paths do not participate.

Final challenge repair: the effective worker ceiling is rechecked against the
transaction-local `liveEntries.length`, including claims committed by another
connection and earlier claims in the same batch. A frozen-review result is only
considered for product-read-only review tasks; it never bypasses a declared
product write. Critical review classification includes canonical `verifier`
role IDs and verification kinds.

## Verification

- `node --check src/backlog-store.js && node --check src/task-resource-policy.js && node --check src/task-scheduler.js && node --check test/backlog-store.test.js && node --check test/task-resource-policy.test.js && node --check test/task-scheduler.test.js`: passed.
- Also checked current executor source/tests with `node --check src/task-executor.js && node --check test/task-executor.test.js`: passed.
- `node .agents/teamwork/task-scheduler-challenge/capacity-race.cjs`, `node .agents/teamwork/task-scheduler-challenge/frozen-writer.cjs`, and `node .agents/teamwork/task-scheduler-challenge/verification-gate.cjs`: all passed their assertions; concurrent-cap output reported active3/sends3 at ceiling3.
- Focused policy/scheduler gate: `node --test test/task-scheduler.test.js test/task-resource-policy.test.js`: 16 passed, 0 failed before the added three regressions.
- Final affected gate: `node --test test/backlog-store.test.js test/task-executor.test.js test/task-resource-policy.test.js test/task-scheduler.test.js test/delivery-events.test.js test/delivery-contracts.test.js`: 81 passed, 0 failed.
- Assigned product files are newly added/untracked at this checkpoint, so `git diff --check` does not inspect them. Node syntax checks above cover all changed JavaScript files.
- Tests cover two-connection stale-projection admission, project-wide claim projection freeze/shape, strict predicate rollback, reduced runtime ceiling across two scheduler connections, four concurrent engineers within lead reservation, fast sibling dependency unlock while slow sibling stays submitted, unknown-attempt capacity hold/no retry, startup poll without resend, reduced future role limits, pause/role subset, shared/isolated write/read conflicts, auditor overlap, product-write protection under frozen review, verifier/verification barrier, engineer task 501 after 500 queued auditors, and paused startup that polls/settles an existing intent without sending a claimed task that has no intent.

## Limits and next step

No runtime/planner/server wiring, live provider, service, or migration is part
of this change. Unknown and thrown executor errors remain parked with durable
capacity; this layer does not infer no-effect settlement. Frozen for same-critic
and challenger re-review.
