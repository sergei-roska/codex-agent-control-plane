# Concurrent foundation APIs

These modules are source-qualified independently of the legacy runtime. Creating
tables or configuring role counts does not activate concurrent delivery. See
[implementation status](implementation-status.md) for accepted and pending gates.

## Backlog and event store

`BacklogStore(db, options)` accepts an existing synchronous better-sqlite3
connection. Its caller owns connection lifetime and the existing FULL-durability
configuration. Construction creates additive `backlog_*` and `delivery_*` tables;
it does not open a provider connection or change project startup.

The first objective fixes the finite project role/total capacities. Later
objectives in that project must use the same settings; active claims across all
of them consume the same pool. Other project IDs remain independent. Reserved
planner slots are excluded from worker admission. A future controller must account
for actual planner turns separately within the same project ceiling.

| API | Contract |
| --- | --- |
| `createObjective(input, options)` | Validates delivery/v1 objective; stores capacity settings and optional trusted checkpoint inventory. |
| `getObjective(projectId, objectiveId)` | Returns objective, plan/control/authority revisions, owner generation, tasks, dependencies and capacities. |
| `applyPlan(projectId, objectiveId, delta)` | Revalidates CAS/graph/authority and materializes supersession/dependency changes in one immediate transaction with its event. |
| `claimReady(projectId, objectiveId, ownerGeneration, options)` | Requires current generation and `options.controlRevision`; atomically reserves task, project/role capacity, attempt, fence and event. Returns `{ task, attempt, claim }` records. |
| `pinSelectedSettings(projectId, objectiveId, attemptId, fence, settings)` | Pins settings before submission; an identical pin is replayable and a different one is rejected. |
| `recordSubmitted(projectId, objectiveId, attemptId, fence, externalTaskId)` | Requires pinned settings, active claim and valid submission state/identity. Same submitted identity replays; expired/unknown attempts require reconciliation. |
| `heartbeat(projectId, objectiveId, attemptId, fence, options)` | Renews a current active claim; cannot revive an expired claim. |
| `settleAttempt(projectId, objectiveId, attemptId, fence, result, evidence)` | Atomically stores one terminal outcome, task state, capacity release and terminal event. Conflicting terminal replay is rejected. |
| `markExpired(projectId, objectiveId, now)` | Marks recovery eligibility and unknown effects while retaining capacity. |
| `reconcileAttempt(projectId, objectiveId, attemptId, fence, facts)` | Requires explicit terminal result and exact trusted quiescence/effect facts; takeover also requires current recovery generation. Missing outcome never implies failure. |
| `requestControl(projectId, objectiveId, action, expectedControlRevision)` | CAS pause/resume/cancel. Admission checks current controls; active effects still require settlement. |
| `advanceOwnerGeneration(projectId, objectiveId, expectedOwnerGeneration)` | Fences stale controller mutations without freeing old claims. |
| `projectBacklog(projectId, options)` | Bounded keyset page. Pass returned `nextCursor` as `afterCursor`; objective-scoped `afterTaskId` is also supported. |
| `projectCapacity`, `listClaims`, `listAttempts` | Read projections, including immutable attempt contract snapshots. |

Time and ID generation are injectable. Derived attempt IDs use serialized identity
tuples rather than timestamps or ambiguous separators. A synchronous
`selectedSettingsResolver` may pin effective settings during claim; otherwise
`attempt.capturedControls.selectedSettingsKnown` is false until explicitly pinned.
The store does not infer model/effort/Fast from a role name.

Checkpoint acceptance and output trust are synchronous controller facts. Their
callbacks must return exactly `true`. Terminal settlement requires explicit
`remoteQuiescent`, `processQuiescent`, and `effectsSettled` facts; success also
requires trusted controller-validated output. A lease timeout, absent task lookup,
terminal transport status or free-text worker report supplies none of those proofs.
The future execution adapter must bind those facts to the actual remote identity,
processes and output candidate before calling settlement.

`DeliveryEvents(db, options)` exposes `append`, `appendInTransaction`, `replay`,
`cursor`, and `advanceCursor`. Sequences are monotonic per project; dedupe conflicts
reject instead of silently replacing evidence. `appendInTransaction` refuses a
call outside an active SQLite transaction. Consumer cursor advancement is durable,
monotonic and cannot skip into the future. Consumers must commit their own state
changes and cursor together when they need exactly-once local application; a
stored cursor does not make external effects atomic.

Local qualification uses real separate SQLite connections, worker-thread claim
contention, failure injection and reopen fixtures. It does not qualify remote
dispatch, publication, automatic scheduling or provider throughput.

## Immutable candidates

`CandidateStore({ db, workspace, storageDir, admission, controls, quiescence,
apply, eventHook, clock })` uses owned storage outside the source workspace.
Capture/materialization work without publication adapters; `publish` fails closed
without trusted adapters. Construction does not install legacy service hooks.

`captureManifest` records Git HEAD and all tracked plus nonignored untracked
regular files, complete bytes and executable modes. It leaves index/HEAD intact
and rejects unsupported symlinks, submodules, unresolved index entries and special
files. Ignored files are outside this source contract. `createCandidate` stores
immutable identity/lineage with a durable generation high-water.
`projectDeliveryCandidate` produces a validated delivery/v1 projection; internal
check identity remains separate. `readManifest` verifies canonical metadata and
blob hashes. `materialize` creates a fresh advisory read-only copy, preserving
executable mode; filesystem ownership is not strict confinement.

`publish` pins the complete candidate identity, before/expected manifests, delta
scope and control/fence identity before effects. It requires exact project,
objective, attempt, numeric control revision and fencing token from the admitted
lease. Candidate, synchronous event hook and settling intent commit together only
after exact content verification. Process quiescence must be literal true, and
admission release/reconciliation must explicitly return released/reconciled.
`reconcile` uses the saved admission identity and pinned candidate metadata;
caller-supplied recovery values are assertions, not replacements. Missing or
partial evidence preserves unknown effects instead of applying again.

References, parent lineage and unresolved intents protect metadata retention.
`collectGarbage` prunes only unreferenced metadata and reconstructible manifest
caches. Immutable blob files are retained for the state database lifetime; safe
physical blob reclamation is outside this implementation. SQLite's complete
manifest JSON is authoritative. Missing cache files reconstruct on read/reopen,
including reuse during another connection's cleanup; an existing corrupt file
still fails validation. This explicit retention policy prevents filesystem
cleanup from deleting another connection's newly referenced source evidence.

Git/filesystem effects and SQLite commits are not atomic. The future runtime must
provide adapters to existing admission, actual process identity, pinned settings,
attested task scope and owner controls. Known candidate status identifies frozen
content; it does not assert that the moving workspace still matches that content.

## Owner corrections and checkpoint inventory

The source-qualified BacklogStore extension adds
`applyOwnerCorrection(projectId, objectiveId, correction)` and two constructor
callbacks. This is a trusted controller operation, not a planner proposal tool.

The correction contains exactly `sourceMessageId`, `expectedGoalRevision`,
`expectedAuthorityRevision`, `expectedControlRevision`, and `requirementDigest`.
`ownerCorrectionAuthorized({ projectId, objectiveId, sourceMessageId, correction })`
must return synchronous literal `true` on every invocation, including exact replay.
Authorization happens inside the immediate transaction before objective/replay
lookup. An exact authorized replay skips stale CAS and performs no additional
state/event write; changed content under the same source ID is rejected.

An initial correction increments goal/control revisions once, preserves checks
and authority, and blocks unstarted work for explicit revisioned replanning.
Active contracts and terminal evidence are unchanged. New claims capture
`goalRevision` in `capturedControls`; trusted no-effect recovery closes the proved
attempt but blocks stale goal or authority scope with
`owner_correction_replan_required` instead of requeueing it. Legacy attempts without
a captured goal may retry only at objective goal revision 1. Same-goal pause/resume
control changes preserve ordinary bounded retry. Owner pause/budget/technical
intent is preserved; validating transitions back to planning. Callers must keep
original correction payloads for crash replay rather than reconstructing expected
revisions from an already advanced objective. Registry/inbox acknowledgement and
correction state must share a transaction or have a pinned idempotent replay path.

`checkpointInventory({ projectId, objectiveId })` returns synchronous bounded minimal
references `{ projectId, objectiveId, checkpointId }`. It is validated and unioned
with stored references inside plan validation's transaction. Inventory establishes
existence only. Acceptance still requires the separate trusted literal-true
`checkpointAccepted` callback; a listed checkpoint is not passing evidence.

## Execution adapter

`TaskExecutor` takes the store/shared DB, `transportFor`, `settingsFor`, `roleFor`,
`requestAdapter`, `resultAdapter`, and optionally the existing dispatch journal.
Its public execution identity is project/objective/task/attempt/fencing token.

| API | Contract |
| --- | --- |
| `execute(identity, {signal})` | Pins supplied settings, adapts/validates the task, commits exclusive send intent before network, and submits or reconciles an existing intent. |
| `poll(identity)` | Observes a pinned remote task, validates context/thread/task identity, and settles only through trusted result evidence. |
| `reconcile(identity)` | Looks up the deterministic context after uncertain submission; missing lookup does not authorize blind writer resend. |
| `acceptTerminal(identity, remote)` | Validates terminal remote identity and controller-supplied output/process/effect facts before durable settlement. |
| `abort(identity, {signal})` | Requests cancellation but retains uncertainty until remote/process effects are actually confirmed. |
| `transportFailed(transportKey, error)` | Marks every live attempt in that shared project transport group uncertain. |
| `getAttempt(attemptId)`, `listEvidence(attemptId)` | Returns persisted executor intent/evidence; intent identity is distinct from a model's report. |

`requestAdapter` runs after selected settings are pinned. This is the safe boundary
for a future review adapter to bind the actual claim when the initial claim did
not already have settings. A first provider-observed thread remains separately
pinned. Transport failures and continuation compatibility must respect that exact
identity. Source-qualified fakes do not demonstrate live provider throughput.

## Task scheduler

`TaskScheduler` takes the store/executor, project/objective, controller identity,
role set/limits, writer mode and optional synchronous admission/frozen-review
callbacks. `start`, `wake`, `runOnce`, `stop`, and `projection` operate per project
objective. Stopping scheduler polling is not cancellation or an owner stop.

Readiness and effective capacity checks run through the store's `canClaim` hook
inside the same immediate claim transaction. The hook receives frozen task/live
projections. It cannot await network or return a truthy non-boolean as permission.
Project/role ceilings include settling/unknown claims and reserve lead slots.
Each terminal outcome can unlock work independently of slower siblings. Backlog
scanning is paginated across all ready work, not limited to the first page.

Private writer mode permits compatible independent product writers. Shared mode
serializes product writers while safe read-only work can overlap. Source scopes,
read dependencies and named resource conflicts remain distinct. A review's
`baseCandidateId` alone is not proof of frozen review inputs; only a qualified
registry-backed `isFrozenReview` fact relaxes the conservative write barrier.
Unknown outcomes remain parked with their capacity/fences until reconciliation.
Future submitted poll deadlines are rearmed when a timer fires early. A wake
between result publication and in-flight cleanup preserves the next deadline;
in-flight attempts do not themselves drive timers. Stale and parked deadlines
are pruned, and stopping the scheduler clears its timer.

## Candidate-bound reviews

`CandidateReviewStore` shares the CandidateStore/project SQLite handle. Registration,
proposal, claim/thread binding, execution verification and promotion have separate
trusted synchronous callbacks; authorization requires literal `true`, not a truthy
model field. Current owner/requirements/check identity and controller-attested
closure remain part of the context. Unknown closure cannot justify promotion.

| API | Contract |
| --- | --- |
| `registerCheckpoint(input, authorization)` | Registers immutable scoped context/dependency requirements under trusted authority. |
| `checkpointInventory({projectId, objectiveId})` | Returns scoped existence references for the backlog; inventory is not acceptance. |
| `proposeReviews({projectId, objectiveId, checkpointId, candidateId, reviewers}, authorization)` | Produces delivery/v1 tasks against a known candidate and complete scoped checkpoint graph. It does not invent execution attempts or provider threads. |
| `getReviewTask(taskId)`, `isFrozenReview(input)` | Exposes the exact registered task/context and verifies a real registry-backed frozen-review capability. |
| `bindClaimedAttempt({task, attempt, claim})` | Requires a real claim, matching contract/fence/generation/provider context, and already pinned selected settings. |
| `pinObservedThread({taskId, attemptId, fencingToken, providerContextId, threadId})` | Pins the first trusted provider-observed thread and rejects a different replay. |
| `prepareReviewInput(taskId, destination)`, `verifyReviewInput(prepared)` | Materializes frozen bytes and checks actual before/after manifests; chmod alone is not confinement. |
| `settleReceipt({taskId, outcome, evidenceRefs})` | Validates exact bound trusted execution, current context and effect/check facts; creates one immutable receipt/event/reference transaction. |
| `qualification(...)` | Returns receipts/promotions for the exact project/objective/checkpoint/candidate/role; does not rename a historical receipt. |
| `promoteReceipt({receiptId, targetCandidateId}, attestation)` | Uses the receipt's stored immutable context, proves unchanged complete input closure and pins, and writes a separate promotion. |
| `canReviewTogether(leftTaskId, rightTaskId)` | Allows same-candidate read/read overlap only with independent checkpoint evidence and disjoint scratch/resources. |
| `isFinalStabilized(...)` | Queries current registry qualification; CN-12 must still freeze publication and execute final owner checks. |

Review tasks retain actual checkpoint acceptance dependencies. A verifier/auditor
pair is ordered when the auditor consumes verifier evidence; independent auditors
can share source read paths. Scratch ownership remains separate from product
write permission. The legacy configured verifier integration obligation in CN-14
must be qualified before this registry is routed to real role execution.

The receipt's SQL `context_id` is authoritative for promotion; a newer context for
the same checkpoint/candidate cannot replace it. Exact receipt/promotion replay
preserves the first timestamp and record across clock change/reopen; conflicting
evidence/attestation returns a typed conflict. All context/receipt/promotion refs,
rows and events share one immediate transaction. Rollback never performs an
unconditional deletion of another committed caller's deterministic reference.

Local gate: critic APPROVE, challenge HOLDS with seven actual API probes, focused
18/18 and adjacent60/60 tests. These qualify local identity, retry, atomicity and
retention behavior; they do not qualify server routing or provider performance.

## Available lead, durable inbox and continuous planning

`DeliveryInbox` is project/session/objective scoped. `receive` durably acknowledges
receipt immediately; received is distinct from applied. Owner corrections require
an injected trusted authentication callback, independent of caller payload flags.
`pending`, `messages`, `get`, `projection`, trigger operations and exact-version
`completeTurn` expose bounded state. Applying a plan and acknowledging its captured
steering messages share one immediate transaction. Correction, acknowledgement
and next trigger also share a transaction with the store extension.

`LeadPlanner` accepts trusted `runTurn`, settings/context, reconciliation/recovery
adapters and the existing store/inbox. `run`, `projection` and `listEvidence` keep
planning separate from workers. Actual provider thread identity must come from an
explicit `providerThreadId` or canonical trusted `contextFor().threadId`; unknown,
mismatched or ambiguous aliases fail closed. The transport scope is separately
pinned. A synthetic session label is not a provider thread identity.

The planner fixes its owner generation at construction, pins it with goal/control/
checks/inbox revisions, and rechecks it before the model call and inside acquire/
apply transactions. A stale object cannot adopt a replacement owner's generation,
mutate tasks, or acknowledge steering. Project-wide planner reservations and exact
physical thread/scope fences include active and unknown turns. Pending model output
is retained only as stale evidence when owner intent or inbox state changes.

Ordinary admission never retires a live active turn, even if a reconciler says
there were no plan effects. An unknown turn needs exact project/session/turn/
provider scope/thread/original-generation proof and literal remote/process
quiescence before fence release. The explicit
`markPriorTurnRecoveryEligible(proof)` operation requires default-deny trusted
`authorizeRecovery`; CN-11 must supply genuine lifecycle evidence for crashed
active turns. The planner does not infer quiescence from lease expiry or absence.

`ProjectDeliveryController` exposes `start`, `receive`, `wake`, `runOnce`, `stop`
and `status`. Its scheduler retains a fixed owner-generation fence while authorized
corrections update the known control revision. Successful replanning can claim/send
a replacement task; it does not remain stuck on the initial control revision.
Busy sessions retain a durable wakeup and bounded100ms-2s retry, canceled by stop
and recovered from persisted inbox state on restart. No repeated model call occurs
on an idle queue or while the provider slot is busy. Pause/terminal controls block
new planner turns while receipt/status remain available.

Controller stop currently stops its scheduling/timers; it is not the CN-11 owner
stop/cancel protocol. Full lifecycle recovery, budget wakeups, final acceptance and
server routing remain later gates. Local CN-09 gate: final critic APPROVE, targeted
owner-takeover challenge HOLDS, related tests92/92. The combined new-engine suite
passes152/152 at this checkpoint.

## Backlog and team visibility

CN-13 is source-qualified with independent critic APPROVE,50 focused tests and
actual Chrome fixtures at desktop1440/mobile390. `projectDeliveryObjectives`
and `projectDeliveryVisibility` in `delivery-visibility.js` query the existing
connection read-only; they never construct stores or create optional tables.

The launcher adds GET `/api/projects/:id/delivery/objectives` and GET
`/api/projects/:id/delivery/backlog`. Objective, optional session, bounded limit
and opaque project/objective/session cursor stay scoped on every page. Absent
legacy tables return unavailable state. Task readiness follows persisted trusted
output/revision/effect facts; missing checkpoint acceptance is unknown.
Project-wide live claims determine role occupancy, while task counts remain
objective-scoped. Planner activity is explicitly session-wide.

Configured ceilings are labeled separately from currently unknown runtime
admission/capacity/resource policy. CN-14 must connect those actual runtime facts.
The Backlog page discovers objectives, shows unknown readiness and detailed idle
causes, and refreshes selected loaded pages with stale-response guards. The UI
loads at most10 pages; the API can continue beyond that bound. Performance token
source/UI are unchanged. Passing these fixtures does not activate the new engine.

Each visibility attempt also exposes nullable `waits.backlogMs`, `writerMs`,
`providerMs` and `settlementMs`. These are separately labeled processing intervals:
initial revision-1 task creation to first claim (including dependency/control
wait), publication admission acquisition, provider invocation to observed turn
start, and observed terminal to durable settlement (including checks/publication).
They are not mutually exclusive pure idle durations or live provider latency.
Missing endpoints, historical rows, revised/retried backlog attempts and ambiguous
publication timing remain unknown; unknown token values remain null. Reads never
create telemetry. Separate best-effort admission timing does not grant publication
authority or alter candidate/intent identity. The Backlog UI renders these scopes.

## Lifecycle and bounded recovery

CN-11 is source-qualified with independent critic APPROVE and targeted challenge
HOLDS. `DeliveryLifecycle` binds fixed project/objective/owner-generation/control
identity, owner pause/stop/resume/cancel, durable budget waits and finite retries.
`recordTransientFailure` requires scopeType/scopeId; strategies are counted within
validated objective/task/checkpoint scope. Local exhaustion preserves ready siblings.
Trusted budget eligibility must return synchronous literal true for the unchanged
wait; a later owner pause cannot be resumed by an old budget wake.

`TaskExecutor.recover(identity)` requires exact synchronous no-effect/quiescence
facts bound to persisted attempt, claim, context, intent, fence and recovery
generation. Missing proof or a changed owner retains capacity; no blind resend.
`ProjectDeliveryController` adds pauseObjective, emergencyStop, resumeObjective,
cancelObjective and shutdown({pause}). The shutdown latch fences future admission
and entered cycles; `shutdownProjection().safeToRelease` requires explicitly
stopped admission and settled controller/planner/claim/publication facts.

`BacklogStore` adds typed lifecycle controls, budget/retry records and wake/resolve
operations, blockLifecycleRetry, blockTechnicalIfNoProgress, requestLifecycleRecovery
and settleRecoveredNoEffect. All mutations retain generation/control checks and
atomic events. The separate CN-12 finalization gate is described below.

## Required owner decisions (V14 candidate)

This candidate is under integration qualification. A planner `ownerDecision` is
null for routine work, or a strict named question with a supported HUMAN_REASONS
category, declared options/recommendation, completed source-read-only investigation
references and current task/objective-acceptance obligations. A versioned durable
request and its post-registration revision pins establish `waiting_owner`.
Pending requests fence plan/claim/resume/finalization even if a disposition is
incorrectly changed. The facade returns `input_required` instead of polling a
model. Status exposes the question, immutable request digest and current reply pins.
This is a conservative whole-objective gate, not selective obligation deferral.

Authenticated POST `/control/delivery/:runId/decision` selects one declared option
using exact run/project/session/objective scope, request digest, message identity
and current plan/goal/authority/control/owner-generation pins. Exact committed
replies deduplicate before stale-pin validation and never wake twice. An answer
retains a later owner pause/stop; it cannot resurrect cancellation. Generic
steering, model output and resume do not resolve required decisions. Selecting an
option grants no spending, credential, external-write or requirement-change
capability; those actions retain their separate authority boundaries.

Changed decision-relevant pins require authenticated POST
`/control/delivery/:runId/decision/replace`, naming the original digest, current
pins and a complete replacement question. History and original investigator pins
are retained. A default-deny synchronous replacement-only callback may revalidate
only the original immutable successful investigation evidence against its retained
candidate manifest and the real unchanged shared tree. Missing observation, drift
or changed proof denies reuse. The owner explicitly adopts that retained evidence
for the replacement question; tree equality establishes observation continuity,
not semantic relevance. Revalidation is recorded separately. Initial registration
keeps its strict current-investigation requirements.

## Final acceptance join

CN-12 is source-qualified with independent critic APPROVE and targeted challenge
HOLDS. `finalizeCandidate(...)` in `delivery-acceptance.js` joins the typed store
barrier, durable check start, real frozen-candidate checks, and atomic terminal
commit. Contract digest/source/required check IDs, selected execution permissions,
scratch settings, candidate manifest/environment and objective revisions remain
pinned. Candidate-bound registry receipts and trusted lifecycle facts are required.

`BacklogStore` exposes `beginFinalization`, `startFinalizationChecks`,
`recordFinalizationChecks`, `commitFinalization`, `invalidateFinalization`,
`getFinalization`, `listFinalizations` and `currentFinalizationQualification`.
Authorization callbacks default to denial and require synchronous literal true.
Replay reauthorizes, preserves the original evidence/timestamps, and never reruns
checks. A ready record can finish its commit after restart. Checking or unknown
records require trusted `reconcileFinalizationCheck` proof before another check.
`markFinalizationCheckUnknown` retains the materialized workspace and external
Git control context when execution effects are unresolved.

`CandidateReviewStore.finalizationProjection(...)` reads exact current closure,
receipt and pin qualification without changing review settlement or promotion.
Finalization refuses runnable, blocked, unsettled or delayed work, pending inbox
or planner recovery, and unresolved publication effects. Failed owner checks or
candidate mutation reject the attempt. Terminal partial requires a complete
investigated ledger with trusted remainder provenance; internal failure alone
cannot produce it. Later candidate/control changes invalidate current
qualification while historical evidence remains attached to its immutable candidate.

The join does not activate an engine. CN-14 still must compose actual trusted
publication, role execution, recovery and lifecycle adapters in server startup.

## CN-14 integration prerequisites

These source-qualified adapters do not yet compose or activate the concurrent engine.
`createDeliveryRoleCapabilities(...)` resolves an opaque verifier capability from
current durable claim, task, attempt, settings, request and candidate identities.
Both TaskExecutor and configured A2A validation resolve independently. The scoped
AppServer path uses private scratch cwd, explicit scratch writable roots and
inherited approvals. It rechecks authority at the actual turn/start write boundary.
Candidate-bound receipts follow durable attempt settlement and trusted host evidence.

`CodexAppServer.prepareThread(...)` creates a physical thread without a model turn;
its tool and permission pins match subsequent run. The switching wrapper tracks
preparation in flight. Engine composition must separately pin account/home identity
across preparation and execution.

`DeliveryOutputArtifacts` provides bind, capture, get, publish and
reconcilePublication. Stable candidateStoreOptions plus one-time attachCandidateStore
compose real WriterAdmission and CandidateStore publication. Capture preserves
immutable private lane bytes, patch and exact host thread/turn terminal evidence.
A shared provider may remain alive; detached publication requires process quiescence.
Replays reauthorize and derive current effect state from the exact CandidateStore
intent. Unknown effects retain evidence and fences across reopen. Base drift is
refused; artifacts are not automatically rebased. Core wiring must supply actual
host authority/effect facts and route engineering output through this bridge.

## Additional CN-14 composition seams

`DeliveryRoleService` provides authenticated concurrent A2A routes, durable host
execution evidence and TaskExecutor result/receipt adapters. Private outputs are
published only through CandidateStore. Explicit strict verifier mode is supported;
unavailable inherited policy stays rejected. Fast mode retains inherit/off/on.
An admitted terminal result after same-owner pause/correction can settle without
stale publication; actual unknown effects remain held.

`CandidateReviewStore.supersedeCheckpoints` records complete owner-authorized
replacement coverage without changing checkpoint/receipt history. Active inventory,
graph and pending review projection agree; live old attempts remain fenced.
`checkpointHistory`, `checkpointSupersessions` and `isCheckpointActive` expose the
read side. The post-run `finalizeCandidate.onChecksExecuted` hook lets composition
persist exact host check proof before recording a result. Provider-home pinning is
checked inside the switching wrapper after account settlement.

The server now composes the settings selector and persisted engine router.
New runs use the selected default; immutable stored mappings retain their engine,
objective/session and original intake. Unknown provider/planner/publication state
still refuses unsafe downgrade or conflicting intake. Composed migration and
exclusion fixtures and bounded CN-14/CN-15 offline integrated acceptance are
qualified. Live activation remains a separate gate.

## Staged terminal shutdown

`ConcurrentDeliveryEngine.fenceShutdown`, `prepareShutdown`,
`beginProviderShutdown` and `finishShutdown` separate admission fencing/local
drain from provider close and final effect reconciliation. Durable phases retain
original producing groups and newly observed host groups across retries/reopen.
A caller timeout preserves database/workspace ownership and a still-running
provider-close operation. Same-host retries preserve a completed released phase;
a fresh host lifecycle may begin a new drain.

Failure-only role preparation requires the exact durable producer tuple,
qualified provider-managed cleanup receipt, independently gone original group,
current owner and unchanged request/settings/lane/output bindings.
`TaskExecutor.reconcileTerminalFailure` closes unknown store state and can replay
missing intent/journal closure from the same validated proof. It records failed
or canceled not_published with retained private bytes/report/drift; this is
separate from worktree-only noEffect recovery and normal successful publication.
Final lifecycle/effect projections remain the sole release gate. Unknown or known
escaped effects retain ownership. A managed-terminal receipt does not prove that
arbitrary detached descendants or external effects are gone.


## Required owner decisions

`BacklogStore.registerOwnerDecision`, `pendingOwnerDecision`,
`listOwnerDecisions`, `ownerDecisionPins` and `controlOwnerDecision` implement a
versioned durable decision ledger. Planner `ownerDecision` is null for routine
work, or a strict request with a HUMAN_REASONS reason, named obligations,
options/recommendation and completed trusted read-only investigation attempt refs.
Registration atomically gates the whole objective, including new planner/task
claims and acceptance. Already admitted work retains its existing effect fences.
This bounded contract does not implement selective obligation deferral.

Authenticated host endpoints `POST /control/delivery/:runId/decision` and
`POST /control/delivery/:runId/decision/replace` require exact run/project/session/
objective scope, message and decision IDs, request digest and all five current
plan/goal/authority/control/owner-generation pins. The response selects an option;
it grants no new credential, external-effect or requirement-change authority.
Exact committed message retries return the original receipt before stale-pin
checks; conflicting message reuse fails. Pause/stop remain paused after a reply,
and canceled objectives cannot be reactivated.

Changed goal/authority/owner requires explicit replacement rather than silently
rebinding a request. Replacement-only host revalidation checks the original
immutable investigation references against retained execution/report/manifest
facts and the real current workspace. Original investigator controls remain
unchanged; owner adoption and current pins are recorded separately. Drift or
unavailable observation denies replacement. This avoids requiring a new model
investigation while the pending decision itself blocks new work.

Status projects decision history and current reply pins. A durable pending wait
returns `input_required` without polling the provider; SQLite reopen retains its
request/digest. Composed restart/replacement verification and independent review
approve this bounded contract. Boundary challenge and repaired frozen affected/full
checks pass. Final matrix acceptance is recorded in qualification-matrix.md; live
activation remains separate.
