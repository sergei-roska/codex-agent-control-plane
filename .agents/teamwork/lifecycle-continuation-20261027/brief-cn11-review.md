# CN-11 independent lifecycle review

Read critic role instructions and development-access.md. Cwd is the project root.
Root owns Git/docs. Review actual source after the worker declares a freeze:
backlog-store, delivery-lifecycle, project-delivery-controller, task-executor and
their tests. CN12 may append independent finalization methods to backlog-store;
CN11 functionality is a separate acceptance surface, never infer CN12 acceptance.
Use source freeze copies/hashes and actual delta if overlapping reads are unclear.

Acceptance: implementation-plan CN11, prepared brief-cn11.md, worker handoff.
Review identity/control/authorization and persistence, not just happy-path tests.

Focus on:
- Pause stops new claim/send/planning while admitted attempts drain; emergency
  owner stop requests abort with uncertain capacity held; cancel is terminal and
  late success cannot publish/reopen canceled work. Owner intent stays distinct.
- Fixed generation and exact control CAS on every operation, including budget/
  retry writes, replays, recovery and source callbacks. No options override bound
  controller identity or let a stale instance adopt a replacement owner.
- Budget wait and restart/backoff are durable; trusted literal-true exact wait
  eligibility never resumes later owner pause/stop/cancel or substitutes settings.
- Finite strategy counters are task/checkpoint/objective scoped. Independent
  failures cannot consume each other's budgets; exhaustion cannot stop unrelated
  authorized ready work, including no-effect executor recovery exhaustion.
- Expired lease/missing task/absent intent are not no-effect facts. Exact trusted
  remote/process/effect/context/fence/generation evidence precedes release/retry.
  No duplicate send across connections/reopen; success sibling evidence survives.
- A normal known-terminal validation rejection can take bounded correction with
  exact host proof; exception/held/live planner turn cannot be retired by a model
  or opportunistic recovery. Retain durable trigger, no idle model spin.
- Shutdown safeToRelease requires explicitly stopped admission plus settled
  claims/planner/publication facts. Unknown/default/Promise truthiness fails closed.

Run focused real disposable SQLite/controller/executor fixtures; no shared/live
services, real models, account, target, Git or product/test edits. Report concrete
APPROVE/REJECT/INCONCLUSIVE with evidence and any unqualified criterion. Required
challenge after approval will target exact unknown-effect/recovery interleavings.
