# CN-11: durable lifecycle and bounded recovery

Dispatch only after CN-09 and CN-10 local gates pass independent review and the
required targeted probes. Root owns Git/docs; preserve all predecessor dirty work.
Cwd /home/sr/Projects/Workspace/codex-agent-control-plane, Node CommonJS/node:test.
Read /home/sr/codex-home/agents/worker.toml and development-access.md.

Goal: give the new concurrent controller deterministic pause/stop/cancel, budget
wait and restart/recovery behavior. Do not wire project startup or legacy routes
(CN-14) and do not implement final acceptance (CN-12). Accepted candidate review,
queue, execution and planner APIs are prerequisites, not rewritten dependencies.

Proposed owned files: NEW src/delivery-lifecycle.js and test/delivery-lifecycle.test.js,
narrow src/project-delivery-controller.js hooks and related controller tests.
If store transitions are needed, root grants sole src/backlog-store.js/test ownership
for an explicit narrow primitive before editing. No generic setObjective/updateSQL
escape hatch and no direct raw writes to another module's tables. Existing
requestControl handles owner pause/resume/cancel, and TaskExecutor.abort requests
cancellation without assuming quiescence; reuse them.

Interface intent:
- A lifecycle instance is project/objective/controller-generation scoped and shares
  the project's SQLite transaction connection with the store/controller.
- Owner pause is a durable control revision, stops new worker/planner admission,
  drains existing attempts without canceling them, and keeps status/inbox available.
- Emergency stop records a distinct durable owner-stop cause, aborts admitted
  attempts, preserves a resumable objective, and retains all uncertain claims.
- Explicit objective/task cancellation stays terminal; late results cannot publish
  or reopen canceled work. Process termination is not proof of settled effects.
- Owner resume uses exact control/generation CAS and cannot automatically resume a
  canceled objective or adopt a replacement controller's generation.
- Budget wait and technical/transient retry use typed durable records, bounded
  counters/backoff/next wakeup, source/provider/model identity and control pins.
  Automatic budget wake requires an injected synchronous literal-true trusted
  eligibility fact for that exact wait and unchanged controls. It cannot resume
  owner pause/stop/cancel, change model/account, or spend outside owner policy.
- Recovery after restart reads actual persisted claims, intents, attempts, inbox
  and retry records before new dispatch. An expired lease only requests recovery;
  unknown/live effects keep capacity and fences until the trusted executor proves
  exact remote/process/effect settlement. No blind resend or missing-task=failed.
- Shared transport death fans out to the exact executor transport group and keeps
  successful unrelated evidence. Independent projects retain separate controls.
- Repeated invalid/planning failures have a finite configured correction/replan
  policy; two failures of one hypothesis cause a different strategy. Exhaustion is
  durable blocked_technical, never fabricated completion or a free-text owner ask.

Owner-only decisions retain the existing closed categories and investigated
provenance. Model recovery/ownerDecision metadata is a proposal, not authority or
passing evidence. No automatic model/effort/Fast/account substitution. If normal
planner output is known terminal and rejected only by pure validation, distinguish
it from an unknown live provider turn when choosing a safe bounded retry. Actual
provider effect facts must come from the injected adapter, not a caught exception.

Testing must use actual BacklogStore/TaskExecutor/controller with fake transport,
real disposable SQLite reopen and deterministic barriers/fake clock where useful.
Cover pause before claim/send and during model turn; owner stop vs explicit cancel;
late result/publication race; budget wake after a later owner pause; stale owner
and control generations; restart during backoff; lease expired with live process;
shared transport failure with one successful sibling; no duplicate send/settlement;
finite failed recovery without idle model loop. Final acceptance is injected for
this local gate, not a circular prerequisite. Preserve existing accepted tests.

No live model/provider call, account operation, service restart, target edit,
publication, dependencies or Git mutation. Owned disposable test services only.
Use English/ASCII. Write brief/handoff with actual commands/results and exact APIs,
freeze for independent lifecycle/concurrency critic and targeted failure probes.
