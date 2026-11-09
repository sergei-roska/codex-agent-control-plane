# CN-09 continuation handoff

Status: fourth correction round complete; frozen for same-critic/challenger re-review.

## Verified starting state

- Existing inbox and planner files are present; prior inbox/planner gate has 6
  passing tests. Controller test file is absent.
- `LeadPlanner.#apply` commits plan/evidence/turn state in one immediate
  transaction and rejects changed inbox versions, but `DeliveryInbox` trigger
  state and controller message acknowledgements are separate operations.
- Controller owner correction currently forwards all correction payload fields
  plus sourceMessageId to BacklogStore; BacklogStore extension is present in
  current shared source and must be exercised through actual integration.
- TaskScheduler supports synchronous claim admission inside store claim
  transaction and exposes idle cause; it reserves configured planner slots.
- Planner admission now counts durable active/unknown lead turns against the
  project planner reservation and uniquely fences each live provider thread
  across sessions sharing the database.
- Plan application and steering acknowledgement/trigger consumption now share
  one immediate transaction. Authenticated correction, inbox acknowledgement
  and the follow-up trigger also share one immediate transaction; an unresolved
  authenticated correction fences further claims.
- Controller status exposes recent message state; planner projection carries a
  bounded recent lead-evidence window. Recovery metadata is structurally bounded.
- Busy project-slot or live-thread results retain the durable inbox wakeup and
  schedule an exponential-backoff retry (100 ms to 2 s); stop cancels the
  timer, and restart resumes from the persisted inbox wakeup.
- Planner thread identity is now required from explicit `providerThreadId` or
  canonical trusted context `threadId`; configured/context mismatch and alias
  fields fail closed. Durable thread fences include `transportKey` scope.
- Planner checks objective disposition before turn setup/acquisition and again
  inside acquisition; output from a turn invalidated by pause remains stale.
- Controller keeps its construction-time owner-generation fence and updates
  only control revision after its own authorized owner correction commits.
- Controller retries durable busy wakeups with a bounded exponential interval.
  It clears retries on external wake and stop; startup retries the still-persisted
  inbox wake after reopen.
- Lead turns fail closed for draining, paused, waiting, validating and terminal
  objective dispositions. Captured disposition is rechecked at acquire and
  before applying output.
- Authorized correction integration now verifies a revision-pinned replacement
  task can be claimed and sent. Existing controllers retain ownerGeneration
  across takeover and adopt only control revisions from corrections they commit.
- Ordinary admission never invokes reconciliation for a live `active` provider
  turn; it returns busy and preserves the durable inbox trigger. An `unknown`
  turn is retired only when a reconciler returns exact project/session/turn/
  provider scope/thread identity plus literal `remoteQuiescent` and
  `processQuiescent` facts.
- `markPriorTurnRecoveryEligible(proof)` is a narrow lifecycle adapter API. It
  default-denies without `authorizeRecovery`, checks the exact turn identity and
  original pinned owner generation and literal remote/process quiescence, then
  transitions only that exact active row to `unknown`. Reconciliation also has
  to echo the original generation. Active rows left by a crash remain fenced
  until this trusted lifecycle proof is supplied. No direct SQL recovery route
  exists.
- Planner owner generation is captured at construction, included in turn pins,
  and checked before a turn, under acquisition, and in the apply transaction.
  A takeover makes held output stale and preserves steering as received; an old
  planner remains stale on later runs. Controller passes its fixed generation to
  the planner, while a newly constructed owner can capture the new generation.

## Pending

- Same-critic re-review remains pending. Lifecycle integrations must call
  `markPriorTurnRecoveryEligible` only after their provider/process adapters
  establish quiescence; controller restart alone does not prove it.
- Root owns integration decisions and Git.

## Verification

- `node --check src/delivery-inbox.js && node --check src/lead-planner.js && node --check src/project-delivery-controller.js && node --check test/delivery-inbox.test.js && node --check test/lead-planner.test.js && node --check test/project-delivery-controller.test.js`: passed.
- `node --test test/delivery-inbox.test.js test/lead-planner.test.js test/project-delivery-controller.test.js test/backlog-store.test.js test/task-scheduler.test.js test/task-executor.test.js`: 92 passed, 0 failed.
- `git diff --check`: passed.
- `node .agents/teamwork/cn09-challenge/owner-takeover.cjs`: passed; output is
  stale, no task was inserted, and steering stayed received.
- Latest focused planner/controller suite: 26 passed, 0 failed.

## Constraints

Do not modify shared backlog/scheduler/executor/candidate/legacy files or docs.
Do not perform live service/provider/network/Git/target actions. Keep source and
notes ASCII English.
