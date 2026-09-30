# Product and execution contracts

Version: planning v1, 2026-09-30. These are new implementation contracts derived
from the owner's workflow and M0 decisions, not schemas already present in code.
Existing source boundaries: src/durable-store.js (A2A/journal),
src/lead-orchestrator.js (checkpoint/run), src/acceptance.js (pinned checks),
src/writer-admission.js (writer execution), src/usage-ledger.js (usage).

## Identity and ownership

| Entity | Required fields | Owner and mutability |
| --- | --- | --- |
| Project | projectId, canonicalWorkspace, displayName, gitIdentity, configurationRevision | Operator configuration; pinned per ticket/run; one project per instance |
| Ticket | ticketId, projectId, title, source, priority, status, currentRevisionId, version, createdAt, updatedAt | Product service; status/version only through validated commands |
| RequirementRevision | revisionId, ticketId, parentRevisionId?, description, criteria[], references[], artifactIds[], trackingMode, requestedSpecialty?, actor, createdAt | Immutable; new revision for changes |
| SourceReference | sourceKind, configuredOriginId?, externalId/url, sourceRevision?, fetchedAt?, contentArtifactId?, availability, truncation? | Retrieval adapter; untrusted evidence with provenance |
| Run | runId, ticketId, revisionId, projectId, planRevisionId?, settingsSnapshotId, status, waitReason?, controlRequest?, acceptance?, candidateId?, startedAt?, finishedAt? | Lifecycle controller; one nonterminal run per ticket; validated plan required before engineering dispatch |
| PlanRevision | planRevisionId, runId, parentPlanRevisionId?, presetId/version?, stages[], reason, createdAt | Validated immutable stages/dependencies; new revision for changes |
| Stage | stageId, roleId, dependencies[], objective, required, inputs[], checks[], allowedFiles[], expectedOutputs[], retryPolicy | Plan owner; required/optional status fixed in revision |
| Assignment | assignmentId, runId, planRevisionId, stageId, roleId, brief, inputArtifactIds[], allowedFiles[], acceptanceCriteria[], checks[], stopConditions[] | Dispatcher; immutable accepted brief |
| Attempt | attemptId, assignmentId, ordinal, runtimeTaskRef?, executionId?, status, resultArtifactId?, effectiveSettings, timestamps | Dispatcher/executor; new attempt ID on retry |
| RuntimeTaskRef | namespace, tenant, taskId, contextId | Full A2A identity; taskId alone is not globally sufficient |
| Candidate | candidateId, runId, planRevisionId, baseHead, currentHead, deltaManifest, evidenceArtifactIds[], integrityHash | Immutable candidate under human review |
| Artifact | artifactId, ticketId, runId?, revisionId?, kind, mediaType, storageRef, size, sha256, origin, createdAt | Artifact service; content immutable; metadata access controlled |
| Decision | decisionId, kind, ticketId, runId, revisionId, planRevisionId, candidateId?, actionScope?, state, actor?, answeredAt? | Operator/policy controller; stale on changed bound revision |
| Event | eventId, sequence, timestamp, projectId, ticketId?, runId?, stageId?, attemptId?, revisionId?, type, sanitizedPayload, causationId? | Append-only diagnostic journal; not authoritative lifecycle |

Opaque IDs are backend-generated, not random DOM IDs. Timestamps are UTC ISO-8601;
UI formats local time. Optional fields are absent/null when not known; unknown
usage/cost never becomes zero. Source is direct, jira, or legacy. Beta trackingMode
is internal only; Jira reference does not grant external-write authority.
Requesting a specialty does not bypass the PM coordinating contract.
The form's role field is requestedSpecialty: an optional preference from the
nine-role roster (default unset), not an assignee or permission grant. PM owns
Intake for all requests; validated plans assign actual execution roles.

Use optimistic ticket versions and transactions for state changes. Preserve
actor/provenance for edits. Store runtime relations explicitly; do not infer
parentage from display labels or matching objective prose.

## Ticket state and board projection

| Ticket status | Board column | Meaning |
| --- | --- | --- |
| backlog | Backlog | Saved draft/specification; no dispatched run |
| pending | Pending | Explicitly submitted; waiting for Intake or repository capacity |
| in_progress | In Progress | Active Intake/planning/engineering/checking |
| paused | Needs Attention | Settled run awaiting resume; reason shown |
| waiting_human | Needs Attention | Requirements decision or candidate review required |
| blocked | Needs Attention | Failed prerequisite, stopped run, unresolved execution or unavailable dependency |
| done | Closed | Operator accepted the exact candidate/result after required evidence |
| cancelled | Closed | Cancellation confirmed and active effects settled |

Failed acceptance blocks delivery or enters bounded rework. It does not produce
done. Commit/push is a separately audited delivery action; done does not mean
published. A read-only audit can be done without a code candidate if its required
evidence and human result acceptance exist.

Run states: queued, running, paused, interrupted, completed, failed, stopped,
cancelled. Pending pause/stop/cancel is stored as controlRequest and displayed,
not as a false terminal status. waitReason distinguishes human_decision,
human_review, budget, restart, dependency, execution_error, writer_unresolved,
operator_pause, and run_stopped.

Normal path: backlog -> pending -> in_progress -> waiting_human -> done.
Clarification may go from in_progress to waiting_human and return after response.
Rework goes waiting_human -> pending/in_progress with a new candidate. A failed
run goes blocked; an operator may return it to backlog or request a new run.
No automatic retry may exceed the pinned attempt/round policy. Unrecognized
stored states project to Needs Attention with the raw state and recovery reason;
never silently coerce them to done or editable backlog.

## Commands and atomic effects

All mutations carry commandId, expectedTicketVersion, actor and the relevant
ticket/run/revision IDs. Same commandId and payload returns the prior outcome;
same ID with different payload conflicts. At-most-once local command application
does not claim exactly-once external execution. Persist intent before dispatch;
reconcile unknown runtime/Git effects before retrying.

| Command | Preconditions | Effect and safeguards |
| --- | --- | --- |
| Create | Valid fields, configured project, supported formats | Save backlog ticket/revision; no execution |
| Edit draft | backlog, no active run, expected version | Save immutable revision; update pointer/version |
| Submit | backlog/eligible blocked, valid minimum submission fields, no active run | Create queued Intake run bound to revision; idempotent submission; engineering readiness assessed by PM |
| Answer Intake | Pending decision and exact revision match | Save decision/new requirements if needed; resume permitted work |
| Pause | queued/running; no terminal run | Set dispatch inhibit; settle current execution; paused only after proof |
| Resume | paused/interrupted, unresolved effects reconciled, matching pinned revision | Resume same run/plan/config; do not replace acceptance contract |
| Stop run | nonterminal run | Inhibit dispatch, cancel/settle active attempts, end stopped; ticket blocked/run_stopped |
| Cancel ticket | nonterminal or settled ticket | Inhibit dispatch, reconcile active attempts; cancelled only when settled |
| Stage edit | running/paused/waiting | Store proposed revision; no silent change to active run |
| Apply revision | settled boundary; operator confirms affected work | Invalidate dependent decisions/results; terminate/replan or create new run explicitly |
| Return to Backlog | live run settled through stop if necessary | Preserve histories; create/update draft revision; ticket backlog |
| Request corrections | current review candidate, no active mutation | Save findings; bounded rework; new candidate invalidates old approval |
| Accept result | exact candidate/revision (or read-only result artifact set), required evidence satisfied | Save human acceptance; ticket done |
| Commit | explicit operator action; candidate/hash/HEAD match; repository lease | Commit owned delta only; record commit SHA; no auto-push |
| Push | explicit operator action; reviewed/authorized commit, remote/ref match | Push without force; reconcile ambiguous network result |

Cancel/stop never implies reverting files, deleting branches or undoing an
external effect. Editing existing pinned acceptance checks requires a new
run/contract, not a resume message. Reopening done/cancelled creates an explicit
new ticket revision/run with audit history rather than rewriting old results.
There is no separate beta Restart command: interrupted execution uses guarded
Resume after reconciliation; rerunning settled failed/stopped work uses explicit
Submit with a new run ID (or Return to Backlog, revise, then Submit). Retain old
effects and evidence; rerunning is not rollback or reset.

## Acceptance, attempts and dependencies

Preserve existing acceptance dispositions: accepted, rejected, unverifiable,
unverified, not_required. They describe check evidence, separate from human
acceptance. Check IDs, argv and timeout are pinned at run start; no shell-string
execution from imported content. Use operator/project-approved check policies.
Check output records exitCode, timeout/cancel flags, duration and bounded logs.
Current snapshot limitations, including ignored files, must remain visible.

Attempt states: queued, dispatched, running, succeeded, failed, interrupted,
cancelled, outcome_unknown. A stage succeeds only when its validated result and
required evidence pass. Late output for an old plan may be archived, but cannot
unlock current successors. Attempts and artifact IDs remain stable on collection;
repeated result ingestion does not create duplicate evidence or usage.

Validate stage references, cycle freedom, role availability, bounded inputs/file
scopes, capabilities, prerequisite evidence and required gates before dispatch.
Dependent stages wait after failed/interrupted prerequisites. Preserve completed
evidence and explicit validity decisions when replanning; do not erase attempts.
Per-file scope remains prompt instructions plus delta attestation until additional
enforcement exists. Scope violations reject delivery; do not advertise OS-level
per-file isolation that the runtime does not provide.

## Effective configuration and measurements

Settings snapshot includes provider=openai, runtimeAdapter=codex-app-server,
catalog/model ID, effort, serviceTier?, rolePack/version, roleInstructionsHash,
promptVersion, toolPolicyRevision, projectPolicyRevision, and appServerVersion?.
Resolve against advertised capabilities/account access before new dispatch.
Missing tier metadata makes Fast unavailable; do not substitute effort for speed.
M3 may use current fixed models, but records a snapshot; M5 adds editing/catalog.

Usage entries retain native turn/task identity, available token counts, elapsed
time and provenance. Cache share uses paired known cachedInputTokens/inputTokens,
ratio of sums, with coverage. Keep measured subscription cost null; hypothetical
API estimates are optional and distinctly labeled. No hidden reasoning is assumed.

## M1 read interface and legacy compatibility

Proposed application API prefix: /api/dashboard/v1. Authenticated GET endpoints:

| Endpoint | Output |
| --- | --- |
| /context | configured project, active pack, API/capability versions, server health |
| /roles | role IDs/display names, capabilities and effective defaults where available |
| /cards | paginated cards, filters, snapshot timestamp and continuation token |
| /cards/:id | detail, raw execution status, acceptance, waits and capability availability |
| /cards/:id/attempts | explicit assignment/attempt/runtime relations and outcomes |
| /cards/:id/usage | known/partial/unavailable measurements and coverage |

Use bounded page sizes (default 50, maximum 100), stable updatedAt/ID ordering
and opaque cursors. Validate query filters; no caller-selected table, filesystem
path or arbitrary A2A namespace. JSON error shape: code, message, requestId,
details?; credentials and stack traces excluded. Codes include unauthorized,
not_found, invalid_request, stale_version, unavailable, conflict. Poll every
3 seconds while visible, back off to 30 seconds after repeated failures, cancel
stale requests, and show last successful timestamp rather than fake freshness.

M1 cards expose cardKind=legacy_run, cardId, runtimeTaskRef, projectId,
ticketId=null, title, boardColumn, executionStatus, displayStatus, acceptance?,
waitReason?, updatedAt and available detail/usage. Root orchestrator tasks are
cards; journal-linked worker tasks are children. Unlinked direct specialist tasks
are clearly labeled standalone execution cards, not invented product tickets.
Composite namespace/tenant/task identity prevents collisions. Do not expose
token files or use live model calls to populate the board.

| A2A state | Legacy board column / presentation |
| --- | --- |
| submitted | Pending / queued execution |
| working | In Progress / working execution |
| input_required | Needs Attention / raw pause reason; human, budget, restart or unresolved writer distinguished |
| completed | Closed / completed execution, acceptance disposition shown; human review unknown |
| failed/rejected | Needs Attention / failed or rejected execution |
| canceled | Closed / canceled execution |
| unknown/unrecognized | Needs Attention / unknown execution state |

Never synthesize product done from legacy completed. M2 creates actual tickets
and explicit run associations; migrating historic runs into product tickets is
not required for M1 and cannot rewrite original execution records. M1 API reads
existing SQLite state without running migrations from GET handlers. Diagnostic
event writing occurs in runtime paths, not observation requests.

## Representative contract checks

| Case | Expected result |
| --- | --- |
| Duplicate Submit | One run; second command returns stored outcome |
| Stale Edit | Conflict, original ticket unaffected |
| Pause during writer | Pause requested visible; no new dispatch; settled proof required |
| Restart with unknown writer | Interrupted/blocked projection; no new mutation before reconciliation |
| Old-plan result arrives | Archived attempt; current prerequisites unchanged |
| Completed A2A with failed checks | No product success; acceptance rejected visible |
| Edit candidate after review | Old commit/push authorization invalidated |
| Two tickets share repository | Second mutation-capable pipeline queued until owned delta settled |
| Jira link with internal tracking | Retrieval only; no external status/comment/write |
| Missing cache counts | Unavailable/partial, not observed zero |
| Analytics exporter fails | Execution proceeds; diagnostic failure recorded separately |
| Unauthorized read/download | 401/403; no private ticket data |

Implementation tests belong to their milestones. These cases specify future
validation; M0 does not claim they have been implemented or passed.
