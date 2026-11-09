# AD-05 concurrent cancel and uncertain-effect reconciliation

## Goal

Make concurrent owner cancellation a durable request that fences new work
immediately but becomes terminal only after downstream planner, worker, and
publication effects are confirmed. Keep uncertain attempts visibly unresolved.
On restart or dependency recovery, automatically retry technical reconciliation
by stable attempt identity without resending work. Preserve pause/cancel and
account-generation fences.

## Verified context

- `.agents/teamwork/AD-04-05-research-20261106/map.md` documents current paths
  and coverage gaps.
- `BacklogStore.#requestControl` currently writes `canceled` immediately and
  cancels unstarted tasks. `ProjectDeliveryController.cancelObjective` then
  awaits abort results, which can be `unknown` while remote/process quiescence
  is unconfirmed.
- `draining` is already a durable nonterminal disposition that blocks new
  claims. Lifecycle owner-cancel cause and executor reconciliation/polling
  mechanisms already exist.
- The public status projection treats `canceled` as terminal; keep it truthful.
- Shared worktree baseline is HEAD `ab5c195` plus uncommitted changes. Preserve
  all existing edits.

## Ownership and boundaries

Own this directory and the allowed paths below. This is the concurrent path;
avoid legacy lead-graph/account files owned by AD-02/AD-04. Coordinate any
required overlap with the lead before editing outside this list.

Allowed paths: `src/backlog-store.js`, `src/delivery-lifecycle.js`,
`src/project-delivery-controller.js`, `src/concurrent-delivery-engine.js`,
`src/task-executor.js` only if necessary, `test/backlog-store.test.js`,
`test/delivery-lifecycle.test.js`, `test/project-delivery-controller.test.js`,
`test/concurrent-delivery-engine.test.js`, and this handoff.

No live providers, quota use, runtime activation, credentials, external messages,
Git staging, or commits.

## Acceptance

1. Owner cancel immediately increments/fences control revision and stops new
   claims, while active or uncertain effects keep the objective nonterminal.
2. Queued work is canceled safely. In-flight tasks/planner/publication work is
   not reported canceled until trusted downstream settlement is recorded.
3. Unknown effects survive SQLite reopen and remain held; after trusted
   dependency availability, lifecycle/controller automatically reconciles them
   without duplicate send or workspace effect. Unavailable dependencies stay
   unresolved and expose a next reconciliation action.
4. Race tests prove stale budget wake, planner result, and worker result cannot
   bypass a newer cancel/pause revision or owner generation.
5. Existing accepted-finalization and no-effect retry invariants remain intact.
   Run the focused affected test suites and report exact results.

## Report

Update `handoff.md` with implementation, exact verification, and unresolved
scope. Do not claim legacy-path or integrated AD-05 completion from concurrent
tests alone.
