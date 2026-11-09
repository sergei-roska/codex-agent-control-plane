# V14 minimal durable owner decision contract proposal

Status: proposal only. Production/tests remain frozen. No source edits authorized.

## Verified gap and reusable boundaries

- src/lead-planner.js:230-260 accepts ownerDecision as bounded arbitrary JSON and
  saves metadata, then applies delta and completes the turn without a control gate.
- Existing waiting_owner disposition already prevents store claims, planner turns,
  and engine #advance finalization. It has no durable request or response protocol.
- ConcurrentDeliveryEngine.#waitForTerminal handles paused_owner/blocked_technical
  but not waiting_owner, so an owner wait would currently poll indefinitely.
- BacklogStore lifecycle resume accepts only owner_pause/owner_stop. Keep that
  distinction: generic resume/steering must never resolve an owner decision.
- Authenticated /control/delivery/:runId status/steer already supplies exact scope
  and revision validation. Decision response needs its own typed route and method.
- docs/architecture/concurrent-harness/validation.md V14 and target-design.md:297-309
  require internal routine choices, investigated typed owner questions, explicit
  obligations, and required acceptance unaffected by a model's finish.
- src/contracts.js exports HUMAN_REASONS: paid_resources, credentials_or_access,
  external_write, irreversible_operation, prd_requirement_change,
  infeasible_requirement. Reuse it rather than inventing broader escalation types.

## Request

Replace arbitrary planner ownerDecision with null or an exact bounded object:
{decisionId, reason, question, options:[{id,description}], recommendation,
 evidenceRefs, obligations:[{kind,id}]}.

reason must be HUMAN_REASONS; options at least two, unique printable IDs;
recommendation names an option; question/descriptions bounded, evidenceRefs
nonempty and resolved against durable completed read-only investigation attempt
receipts for this objective. Merely citing free text is insufficient. Obligations
are explicit current task IDs or the current objective's acceptance identity;
unknown IDs and an empty obligation set fail validation. No routine_choice,
implementation, sequencing, transient_failure or automatic escalation category.

In the same SQLite transaction as revision-checked planner application, persist
one pending request with project/objective/session, source planner turn, canonical
request digest, ownerGeneration, plan/goal/authority/control revision pins,
creation time, and resume disposition. Set objective waiting_owner and increment
controlRevision with lifecycle cause owner_decision. Persist immutable request pins
after this increment; returned reply pins name the resulting durable state. Complete the planner turn and
consume its trigger normally. Never fabricate an active/unknown provider turn for
this wait. Repeated exact registration is idempotent; conflicting IDs fail.

For the bounded first implementation, gate the entire objective while pending,
including new planner/task claims and acceptance; retain named obligations and
existing completed work. This is conservative relative to target-design's eventual
unrelated-progress deferral support, and must be documented as bounded coverage,
not claimed as full obligation-selective scheduling. Already admitted workers may
settle under existing publication fences; do not cancel or requeue them.

## Response and persistence

POST /control/delivery/:runId/decision with host authentication and exact fields:
{runId,projectId,sessionId,objectiveId,messageId,decisionId,requestDigest,optionId,
 expectedPlanRevision,expectedGoalRevision,expectedAuthorityRevision,
 expectedControlRevision,expectedOwnerGeneration}.

Deduplicate an exact previously committed reply by messageId and canonical body
before checking current pins. Return the original receipt without another wakeup.
Reused messageId with different content conflicts.

An ordinary new reply must match the pending request digest and option, its
immutable plan/goal/authority/owner pins, and all currently projected reply pins.
The request's post-registration controlRevision is its original control boundary;
newer control-only pins are allowed only through the explicit precedence rules
below. The reply selects an option, never creates paid/external-write/credential/
requirement-change authority. Those actions still require their established
explicit capability/correction gates and mandatory acceptance evidence.

In one transaction record the authenticated answer/digest/time and mark resolved:
- If still waiting_owner with cause owner_decision and unchanged decision-relevant
  pins, restore its saved planning/executing disposition, increment controlRevision
  and create exactly one durable planner wakeup.
- If a later control-only owner pause/stop has occurred, allow an answer carrying
  current reply pins, retain paused_owner and its owner_pause/owner_stop cause,
  and increment controlRevision without starting a planner or scheduler. Explicit
  owner resume is required afterward and only allowed after no decision is pending.
- Canceled remains canceled. Reject new replies to canceled objectives; retain
  request history. An exact prior reply remains idempotent even after cancellation.
- Other later control causes (for example waiting_budget/blocked_technical) are
  retained and cannot be overwritten by a decision answer. An ordinary reply in
  these states is refused unless an explicitly supported retain-control transition
  is implemented and tested; no active-state fallback is permitted.

Goal/authority/plan/owner changes make the old request superseded for answering,
but do not clear its admission/acceptance guard. Generic steering, model output,
resume or correction cannot silently rebind it. Provide a second authenticated
POST /control/delivery/:runId/decision/replace with exact fields:
{runId,projectId,sessionId,objectiveId,messageId,decisionId,oldRequestDigest,
 replacement,expectedPlanRevision,expectedGoalRevision,expectedAuthorityRevision,
 expectedControlRevision,expectedOwnerGeneration}.

replacement uses the complete strict request shape above and the same logical
decisionId. Require current full pins, matching old immutable digest, synchronous
host authorization capability, and revalidated current named obligations and
investigation refs. Evidence is rechecked against current durable facts rather than
blindly inheriting validity across goal/authority/owner changes. A single SQLite
transaction marks the old version superseded and persists the new version with a
new digest and post-transition immutable pins. Keep the old request/response chain.
Only this authenticated operation can rebind a pending question; no model call or
claim is needed to expose or execute the replacement protocol.

Replacement preserves any explicit owner_pause/owner_stop and does not start work;
canceled objectives reject replacement. Otherwise it retains waiting_owner and
owner_decision cause while advancing controlRevision. New answer must name the new
digest; old replies fail. Exact committed replacement retries deduplicate before
current pin checks, while conflicting message reuse fails. Thus changed authority
has a defined resumable path without granting the selected option new authority.

A response that legitimately returns to active disposition also creates a durable
planner wakeup in the same transaction including
request/option references. Controller adopts current lifecycle control revision
before restarting. Prompt projection includes pending/resolved decisions so the
next planner consumes the selected option without asking the owner again.
No schema changes to delivery inbox are needed if response and inbox.signal are
performed synchronously in one enclosing store/controller transaction.

## Gates and projections

- Store request/resolve/replace/list APIs own durable state and authorization capability
  (default deny, following ownerCorrectionAuthorized convention).
- Defense-in-depth pending-request guards in claimReady and finalization start/
  current/commit checks prevent direct store calls or a corrupted disposition
  bypassing the obligation. Ordinary resume must also refuse pending decisions.
- Planner request registration precedes scheduler wake; controller adopts the
  returned controlRevision after planner application.
- Engine wait returns input_required promptly with pause.kind=owner_decision,
  request and revisions. Save paused status; do not poll or repeatedly call a model.
- Authenticated status and lifecycle projection expose pending request, obligations,
  digest and reply pins. SQLite reopen reproduces the same wait without prepareThread
  or model invocation. A valid reply explicitly wakes/starts the run once.
- Shutdown is allowed for a fully drained durable owner wait; unresolved decision
  is a future authorization boundary, not an unsettled provider/publication effect.

## Proposed ownership after root approval

Worker production:
- src/backlog-store.js: decision ledger/APIs, capability authorization, control and
  admission/finalization fences, correction interaction.
- src/lead-planner.js: strict request validation/application and prompt projection.
- src/project-delivery-controller.js: lifecycle pin adoption and decision response
  coordination/wakeup without extra planner loop.
- src/delivery-lifecycle.js: projection and response/control integration.
- src/concurrent-delivery-engine.js: authorization capability, response/status API,
  planner schema/prompt, honest wait facade, replacement/status restart behavior.
- src/delivery-host-controls.js: authenticated exact typed response route.
Paired existing tests for each, plus focused acceptance test if root assigns it.
No terminal reconciliation methods changed. Router/server need no new API if host
controls use router.concurrentEngine, matching current steer route.
Root durable docs: target-design/API/validation coverage and migration notes.
Potential extra scope only if persisted objective schema rejects needed decision
fields; prefer separate table so src/delivery-contracts.js stays unchanged.

## Meaningful verification

1. Routine reversible work plans/executes/accepts with ownerDecision null and zero
   waits. Invalid routine category, malformed options/IDs, unknown obligation and
   missing/unrelated investigation evidence cannot create a request or fake success.
2. Completed investigator -> named owner request -> input_required; ready sibling
   remains unclaimed, verifier/candidate success cannot accept while request pending.
   Assert planner call count stable across event wake and repeated status reads.
3. Unauthenticated, wrong scope/digest/option, stale revisions/generation, generic
   steer/resume and forged model resolution fail with durable request unchanged.
4. Authenticated exact response resolves once; duplicate is idempotent/conflicting
   message denied; selected option enters planner context and accepted candidate
   still needs the real mandatory verifier/check evidence.
5. SQLite close/reopen while waiting: same request/digest/pins, no provider call;
   authenticated response resumes once. Pause/correction/takeover cannot bypass.
6. Answer-after-pause and answer-after-stop record a valid selected option but
   retain paused cause and zero provider calls until explicit owner resume.
   Answer-after-cancel cannot reactivate; prior exact replies still deduplicate.
   Goal/authority/owner changes reject ordinary old replies; authenticated replacement
   with current pins and validated evidence creates a new digest, retains historical
   rows, denies old reply, and resolves once through a newly pinned reply. Corrupted
   replacement digest, stale pins, unrelated investigation or unknown obligations
   leave the existing guard intact. Test exact replacement retry before pin checks.
7. Await race: owner change during planner turn prevents registering stale request;
   pending request during finalization checks blocks commit, preserving prior bytes.

All test commands use env -u NODE_TEST_CONTEXT node --test. No full/acceptance
command may omit the required prohibited-filter skip pattern from worker-brief.

## Review amendment

Amended after integration-closeout-20261028/v14-decision.md REJECT for ambiguous
control precedence and missing authenticated refresh. Whole-objective gating is
accepted bounded V14 coverage, explicitly not selective deferral. The request,
response and replacement transitions above now define the resumable path and
preserve later owner control without creating new effect authority. Await root
and independent decision re-review before any implementation edit.
