# Terminal reconciliation and cooperative retry-close decision

Verdict: APPROVE
Blocking: none for the bounded direction specified below; current implementation
and historical cooperative fixture are not accepted as repaired.
Status: complete
Scope expansion: none

## Recommendation

Implement a distinct shutdown terminal-failure reconciliation operation, with
fenced admission, drained local work, a qualified terminal cleanup receipt AND
independent absence of the producing App Server process group. Retire the
attempt as failed/canceled and not_published. Never call no-effect recovery for
this cooperative outcome, publish it, requeue it, or certify delivery success.

Split host shutdown into drain/preparation and final reconciliation. Terminate
the provider between these phases, retaining the database and workspace locks.
An existing close() resolution is not process evidence. Use a bounded independent
isProcessGroupGone check on saved original identities before final settlement.
No universal absence of all unobservable external effects is required or claimed.
The process coverage is explicitly provider-managed terminals plus the recorded
provider process group, with known escaped-process activity a hard blocker.

This conservative contract is implementable with the current boundary and
process helper. It avoids deciding that a managed cleanup acknowledgement proves
the wider App Server group empty. It also avoids upgrading that group check into
proof about detached descendants that changed groups or external services.

Raw-engine correction/unsafe-shutdown/fresh-resume must be treated separately.
A still-live provider with only the managed receipt does not satisfy this chosen
stronger shutdown reconciliation contract. Keep that case safely blocked unless
the host supplies the same fenced retirement and original-group-gone evidence.
Do not weaken normal resultAdapter identity or force strict permissions to make
that old fixture green. A fake receipt using process.pid is deliberately unable
to establish producing-group absence while the test runner is alive.

## Authoritative facts checked

Read:

- docs/execution-boundary-contract.md:15-38, 361-376: DBC-01 certifies dispatch,
  observed settlement delta and acceptance predicates. It explicitly excludes
  safety of ignored/restored/external/symlink-target effects and per-tool
  prevention. Unknown outcomes retain ownership until quiescence is established.
- docs/execution-permissions.md:61-68 and writer-lanes.js:355-387: cooperative
  worktrees provide coordination, confinement is none, integrate:false merely
  records not_integrated and preserves bytes. It does not wait for processes.
- codex-app-server.js:1288-1341: current affirmative cleanupReceipt is versioned,
  binds generation/process/thread/turn, and requires original identity before
  and after the awaited cleanup RPC. Scope is provider-managed-background-terminals.
- codex-app-server.js:1362-1382, 1698-1730: close sets synthetic childExited and
  resolves exit waiters, sends SIGTERM, schedules delayed SIGKILL, and returns
  without independently establishing group absence. Do not use childExited,
  child=null, closed, empty survivors, or close resolution as that proof.
- process-quiescence.js:62-77: isProcessGroupGone accepts ESRCH or proven original
  leader-ID reuse; an answering group, inaccessible leader, EPERM, invalid PGID,
  and ordinary observation errors do not establish absence. A group that is gone
  says nothing about a descendant which escaped to another group. The opening
  helper comment overstates this if read as universal descendant coverage.
- server.js:1202-1244: host admission becomes unavailable and watchers stop, but
  engine safeToRelease is required before appServer.close. This creates an
  ordering cycle if group absence is required for reconciliation.
- concurrent-delivery-engine.js:364-415: controllers are fenced, cycles/scans
  drained and role activity awaited, then existing shutdown attempts only
  worktree noEffect recovery. Refused preparation leaves claims unresolved.
- delivery-role-service.js:253-365: current no-publication recovery is
  worktree-only, checks durable tuple/settings/provider/lane/binding/request
  facts, and issues noEffect=true. Keep that path unchanged.
- delivery-role-service.js:198-220, 704-732: normal terminal identity requires
  mapped running task/attempt and active unexpired claim. Do not broaden this
  normal publication-capable adapter for shutdown lost-ack or unknown rows.
- task-executor.js:270-344: acceptTerminal supports unknown-store reconciliation
  but first invokes the normal adapter, explaining the raw correction fixture
  refusal. It closes executor intent and dispatch journal after store settlement;
  a distinct failure-only operation needs explicit replay handling.
- backlog-store.js:919-947, 1083-1108, 1129-1138: lifecycle recovery establishes
  unknown/settling state; reconcileAttempt requires unknown and truthful release
  facts. Canceled objectives coerce result to objective_canceled, dropping extra
  result fields. Preserve original report/not_published/proof separately.
- delivery-lifecycle.js:359-390 and concurrent-delivery-engine.js:1121-1135:
  release separately rejects live claims/attempts, planner work, pending inbox,
  unfenced admission and unresolved role/publication/candidate/writer records.
  These checks must remain the final release decision.

## Required proof and effect meaning

1. Validate the complete durable producer tuple against the immutable admitted
   contract, task revision, attempt and claim fence, original owner generation,
   executor request/context/external-task linkage, selected settings and provider
   identity, output binding, and lane ownership. Permit changed current goal/
   control only as a reason for failed not_published retirement, never as authority
   to republish old output or requeue the old goal. For the first implementation,
   require the same current owner generation; takeover remains separately denied.
2. Require host-generated terminal execution, exact provider start receipt,
   thread/turn/generation/process match, and qualified cleanupReceipt with its
   existing method/scope/version/completion. No bare turnTerminal, cleanupSucceeded,
   model report, or caller-supplied true Boolean substitutes for these facts.
3. Require original process identity retained before provider close, with valid
   PID/PGID/start time, and an independent current group-gone observation after
   close initiation. Apply it per producing identity, including older generations;
   the newest App Server identity cannot release another generation's claims.
   Known escaped PID/group or explicit unsettled process/effect evidence blocks
   release even when both ordinary proofs exist. Do not invent absence proofs
   from empty diagnostic survivor lists.
4. effectsSettled here means the observed execution and host-managed ownership/
   publication machinery have a resolved disposition. It does not mean no writes,
   no external actions, scope compliance, or successful delivery. Require no
   unresolved output publication, candidate intent or writer integration. The
   smallest implementation may reject any publication/candidate intent for the
   target attempt rather than interpret partially completed effects.
5. Preserve lane/private report bytes and record output=not_published. For
   cooperative writers, capture and persist a shared-workspace observation
   compared with the retained base manifest or admission snapshot. Label it
   drift since that baseline, not attribution to this worker. Known drift is a
   failure diagnostic, not an empty delta or an updated accepted candidate.
   An unavailable observation is UNKNOWN, never manufactured known/noEffect;
   refuse this new writable reconciliation path until its required observation
   is available. DBC's documented snapshot exclusions remain exclusions.
6. Reread identity/pins/lane/output/process and admission facts after each await
   and immediately before committing. Persist a stable preparation/proof digest
   and failure disposition; mark not_integrated without deleting output. Use
   unknown -> reconcileAttempt, and close intent, thread reservation and dispatch
   journal consistently. Validated terminal replay must finish missing executor
   bookkeeping after a crash; blindly calling reconcileAttempt again fails
   attempt_not_unknown. Digest mismatch or unrelated proof remains a refusal.

## Minimal lifecycle ordering

1. Latch host AND engine admission closed (including direct run/resume callers),
   stop watchers/retries, fence controllers/schedulers and prevent new provider
   invocations/publication. Retain HTTP shutdown responses, database and locks.
2. Drain controller cycles, scans, scheduler inFlight work, active role handlers,
   lead/transient work and publication/integration callbacks. A held invocation
   makes the first close fail while ownership remains retained. Do not treat a
   timeout as successful drain or terminate the provider early to fabricate a
   trusted terminal.
3. Snapshot eligible durable terminal facts and save original provider identities
   before provider shutdown. Preparation must not yet claim processQuiescent or
   release claims. Persist the shutdown phase so timeout/retry/reopen can resume.
4. Start provider close. Independently wait within a bounded deadline for all
   required original groups to be gone. Retain identities if the wrapper clears
   its current client; do not call a lazy processIdentity accessor after closure
   to rediscover them. Partial close, timeout, EPERM or live group retains locks
   and phase state; a later close retries observation without resending work.
5. Prepare validated not_published terminal proof, reconcile the eligible unknown
   attempts, complete consistent executor/journal closure, then re-evaluate all
   unchanged lifecycle/effectsSettled release guards. Pending inbox/planner or
   any unresolved effect keeps ownership even after provider termination. There
   is no provider restart/goal requeue to make final shutdown pass.
6. Only a final safeToRelease result permits HTTP/state close and both lock
   releases. Concurrent close callers share a pending operation; a failed/timed-
   out caller cannot clear state and start overlapping reconciliation. Do not
   cache a pre-provider-close safe result as the final projection.

Provider close after drain is authorized cleanup, not a demand that every claim
already be released. Requiring the latter would retain the present cycle.

## Minimum implementation and tests

Expected production scope: delivery-role-service.js (separate preparation/proof
and preserved drift), task-executor.js (failure-only reconciliation and replay),
concurrent-delivery-engine.js (fenced phase/drain/final integration), server.js
(staged close), and delivery-engine-router.js if needed to expose the phases.
A CodexAppServer close-proof API is optional: the host can independently observe
saved identities after current close(), provided bounded timing/retry state is
correct. If close() itself is changed to await absence, also cover app-server-
switch.js because it currently clears current before awaiting close. Reuse
process-quiescence.js and store reconciliation; avoid store changes unless a
specific atomic replay gap requires one. Pair all changed source with focused
tests. Update the durable contract/API docs to state the bounded coverage.

Required decisive tests:

- Ordinary cooperative lost-ack held-worker: first close retains both locks;
  terminal cleanup then staged provider-group death allows a retry; failed/
  canceled not_published, private bytes/report and shared drift retained, exactly
  one invocation, no candidate/publication, safe SQLite reopen and repeated close.
- Actual CodexAppServer receipt producer with controlled fake RPC plus disposable
  detached child group for shutdown ordering. Assert close resolution alone is
  insufficient and delayed group exit/descendants retain locks. Avoid process.pid
  as a supposedly dead provider fixture.
- Missing/malformed/mismatched cleanup receipt; unknown terminal; alive group,
  EPERM/observation failure; known escaped process; stale owner/fence/settings/
  provider/request/binding; active local work; unresolved publication/candidate/
  writer; unavailable snapshot; pending inbox/planner all deny where applicable.
- Await-boundary drift, two producing generations, overlapping close retries,
  late provider termination after timeout, and crash/reopen after preparation,
  after store settlement and before intent/journal closure. No proof transfers
  between attempts, and no retry creates success/publication or resends.
- Raw-engine unsafe-shutdown/fresh-resume remains an explicit negative with only
  a live managed receipt; a positive needs the chosen retirement proof. Existing
  normal publication identity and worktree noEffect recovery remain unchanged.

## Independent focused probe

Ran node .agents/teamwork/cn14-terminal-20261028/process-contract-probe.cjs.
Result: exit 0. The real CodexAppServer.close/_terminateProcess code with injected
process capabilities returns after SIGTERM while actual state.exited is false,
synthetic childExited is true, and delayed SIGKILL remains scheduled. The actual
process helper returns false for an answering group and EPERM/EIO, true for
ESRCH. No real process was signaled and no provider/service was contacted.

No reviewed source, tests, fixtures, config or Git state was changed. Prior
fixture logs were read as historical evidence, not claimed as fresh runs. The
new scratch probe and this report are ignored local evidence and may disappear.

Pitfall: provider terminal cleanup, provider-group absence, and noEffect are
three different claims; never substitute one for another.
