# First beta master plan

Date: 2026-09-30
Branch: `feature/dashboard-integration`
Status: M0-M8 complete locally; M6 live exit gate passed on 2026-10-01
([M6 acceptance](m6/acceptance.md)); M9 exit gate met for the release candidate on 2026-10-02; publication awaits the
owner ([acceptance ledger](m9/acceptance.md), [release notes](m9/release-notes.md)).
Next phase (owner plan): visual review and fixes of the dashboard first, then role deep dive, observer-mode Jira pilots, and the
branch-to-PR delivery path; see the [M9 handoff](m9/session-handoff.md#next-phase-owner-plan-week-of-2026-10-05). M8 includes a live model-backed prompt comparison and a verified
temporary MLflow Tracking export; production MLflow adoption is deferred. Evidence:
[M7 acceptance](m7/acceptance.md), [M8 acceptance](m8/acceptance.md).
M0 evidence and requirement audit: [M0 index](m0/README.md).

## Release outcome

Deliver a local, single-operator OpenAI-backed application in which the owner can
submit a direct ticket or a Jira issue, observe the team's work, intervene, review
the result, request corrections, and explicitly authorize commit and push. The
owner creates the pull request. Both entry points use the same delivery process.

The beta is a usable engineering team for existing tasks. Autonomous creation of
whole projects, epics, and sprints is a later product phase. Existing infrastructure
is the starting point, not evidence that the dashboard is already integrated.

This plan proposes a bounded beta release rather than a deadline. Each milestone
ends with a reviewable increment and evidence. Calendar estimates follow the
initial contract and prototype extraction work; they are not invented here.

## Requirements and evidence

Use the owner's current instructions over older prototype text. The supporting
decision records are [product goals](product-goals.md),
[dashboard discussion](dashboard-plan.md), and
[telemetry and MLflow decisions](telemetry-mlflow-notes.md).

The interface reference is `artifacts/dashboard`, including the embedded
`Role-Definitions.md` at `js/state.js:633-634`. It is the owner's editable role
vision, not a frozen runtime contract. The lead endorses its nine-role roster as
the planning baseline; detailed responsibilities and permissions still need
contracts. No additional delivery role is required by this roadmap.

The owner requires `artifacts/dashboard/**` to remain unchanged. It is a
read-only reference, including generated files. The application working copy is
`web/dashboard/**`; all integration changes and builds target that copy or other
assigned application paths. Never build into or write changes back to the
reference. See [AGENTS.md](../AGENTS.md) and [CLAUDE.md](../CLAUDE.md).

| Area | Verified starting point | Work needed for beta |
| --- | --- | --- |
| Runtime | A2A endpoints, Codex App Server, LangGraph manager loop | Dashboard application API and product lifecycle |
| Persistence | SQLite tasks, checkpoints, dispatch journal, writer records | Product tickets, revisions, plans, artifacts, decisions, event correlation |
| Execution | One writer per workspace, reconciliation, acceptance checks | Ticket-owned repository execution, branch lifecycle, operator commands |
| Roles | Eight `orch-*` specialists and a read-only lead | Nine business roles and validated routing, without changing the legacy pack's behavior |
| UI | Six tabs and ticket/approval/provider modals | Replace local simulations with real contracts and data |
| Model settings | Startup TOML models and effort | Dynamic catalog, saved defaults, capability validation, effective-setting history |
| Integrations | Local OpenAI/Codex OAuth execution | Read-only Jira/Confluence retrieval and linked internal tracking |
| Telemetry | Automatic usage ledger, runtime event callbacks | Durable correlated events, quality evidence, cache metrics, MLflow experiment |

Backend evidence: `src/server.js:407,432,477,482`,
`src/durable-store.js:29,93,118`, `src/role-catalog.js:110,146,168`,
`src/lead-graph.js:419,983`, and `src/usage-ledger.js:10`.
These are source inspection findings. M0 subsequently validated the existing
suite: 317 tests passed, none failed/skipped. See [baseline](m0/baseline-pilots.md).
Live OpenAI behavior and the proposed integration remain unverified.

Prototype evidence: `js/layout/sidebar.js:67,98`, `js/tabs/board.js:227,256`,
`js/modals/ticket-modal.js:168,417,516,653`, `js/tabs/pipelines.js:2`,
`js/tabs/monitor.js:42`, `js/tabs/decisions.js:48,136`,
`js/tabs/docs.js:2,37`, `js/tabs/connections.js:101,196`, and
`js/modals/provider-modal.js:491,510`. Paths are relative to
`artifacts/dashboard`. These identify prototype behavior, including simulations;
they do not establish real execution or approval semantics.

## Beta scope

### Included

- All six tabs provide truthful data or explicit empty/unavailable states for
  the supported beta workflow. There are no fabricated executions or balances.
- One configured target Git repository per server instance. Its identity is
  explicit and pinned to tickets/runs. Working on another project is supported
  through deliberate instance configuration, not a global branch switch mid-run.
- Direct New Ticket creation and Jira issue intake, with linked parent/epic and
  Confluence context where accessible. References retain source provenance.
- PM-led requirements clarification, bounded technical planning, versioned
  presets, independent review/testing, and human result review.
- Nine delivery roles with capabilities and tools appropriate to the work.
- Operator pause/resume, stop-run, cancel-ticket, draft editing, controlled
  revisions, and return-to-backlog, with distinct documented meanings.
- Dynamic OpenAI model choices, supported reasoning effort, and Fast/service-tier
  handling only where the installed protocol and account support it.
- Automatic telemetry, cache metrics, review feedback, and a bounded MLflow
  tracing/evaluation experiment after the initial board.
- Read-only Jira/Confluence context and linked internal tracking. The owner
  explicitly deferred Jira writes in M0: beta never creates issues or publishes
  comments/status changes. Source status and internal lifecycle stay separate.
- Real attachment storage and an explicit supported-format matrix. Reference
  links and stored files are distinguished from content actually read by agents.
- Operator-authorized commit/push, plus local installation, recovery, and release
  documentation.

### Deferred

- All Jira/Confluence writes, including issue creation, comments/status changes.
- Autonomous portfolio management, project generation, epic/sprint planning,
  bidirectional synchronization of all Jira fields, and automatic PR creation.
- Claude/Gemini and multiple OpenAI authentication modes. The first adapter
  preserves the current Codex ChatGPT OAuth path; API-key mode is a separate
  future decision, not an implicit addition.
- Multi-user/remote hosting and concurrent projects in one server instance.
- Parallel developers writing to a shared checkout, distributed execution,
  a general visual pipeline or role-policy editor, and project-specific
  per-role system-prompt rules. Track the latter in the
  [project configuration backlog](project-configuration-backlog.md).
- Slack, Figma, and Google Tag Manager integrations, OAuth connection management,
  a provider-neutral integration manager with separate adapters, and a dedicated
  Integrations tab. Slack, Jira/Confluence, and Figma are the required integration
  baseline for work projects. GTM, Salesforce, cookie consent platforms, and
  hosted Git are situational connectors enabled only where needed. Beta can
  preserve links without claiming these future connected integrations. Track
  provider work in the
  [external integrations backlog](integrations-backlog.md).
- Automatic production prompt replacement and a background maintenance agent.
  Record the extension boundary now; add the agent after validated evaluation
  data exists. It is outside the nine-role delivery roster.
- OpenTelemetry instrumentation, MLflow GenAI traces and feedback, production
  MLflow adoption, and Node-only prompt improvement. Python-based integrations
  (DSPy, MLflow's Python SDK and optimizers, sidecars) are rejected by the owner.
  Planned after beta; track in the
  [observability and prompt optimization backlog](observability-optimization-backlog.md).
- Battle Pass: preserve its prototype source unchanged. Do not implement or
  design it during beta work. No payment functionality is planned.

## Design rules

1. A board card represents a product ticket. A ticket owns immutable requirement
   revisions and execution runs; runs own plans, assignments, attempts, results,
   and decisions. Legacy A2A tasks need a documented compatibility projection,
   not an assumption that worker tasks are independent user tickets.
2. Execution state and lifecycle transitions are authoritative in backend code
   and storage. UI actions request commands; dragging a card cannot declare
   successful execution or bypass acceptance.
3. PM owns business requirements, coordination, and delivery communication.
   Architect owns technical decomposition, contracts, and implementation scopes.
   One effective coordinating authority is used per run. Resolve how the PM
   maps to the current lead through the [M0 role contract](m0/roles-tools.md),
   avoiding a competing second planner.
4. Versioned presets describe a task's intended stages. The existing cyclic
   manager runtime can implement bounded retries and replanning inside that
   envelope. Validate and persist plan revisions before dispatch. Do not label
   the current graph a strict, preplanned DAG.
5. Retain OpenAI, A2A, LangGraph, and SQLite unless a measured requirement
   justifies a change. Do not introduce a frontend framework, queue, vector store,
   or distributed database merely to make the roadmap look complete.
6. Preserve legacy profile behavior through an explicitly selectable delivery
   pack/configuration. Keep `main` unchanged during branch development; verify
   legacy compatibility before eventual integration.
7. Start with one repository-mutating ticket pipeline at a time per checkout.
   A per-turn writer lock alone cannot prevent interleaved branch/context
   contamination between tickets. Parallel read work requires stable context.
8. Imported documents are evidence, not permission grants. Tool access, external
   writes, budget limits, and Git operations are enforced outside model prompts.
9. Defaults apply to new runs. An active or resumed run keeps its pinned role,
   model, prompt, plan, and requirement revisions unless a recorded revision
   transition explicitly replaces them at a safe boundary.
10. Telemetry runs without board tickets. Failure of an analytics exporter does
    not fail delivery. Credentials are excluded from traces; unavailable usage
    and subscription cost remain unavailable rather than becoming zeros.

## Nine-role planning baseline

| Role | Responsibility | Boundary to define |
| --- | --- | --- |
| Project Manager | Intake, requirements, readiness, priorities within delegated goals, team coordination, delivery report | Business decomposition; no replacement for specialist checks |
| Architect | Repository analysis, technical design, data/API contracts, impact analysis, scoped implementation plan | Technical decomposition and arbitration; proportional involvement |
| Developer | Implementation, focused unit tests, refactoring, correction of findings | Assigned files/contracts; no self-approval of delivery |
| QA | Independent behavior and acceptance verification, edge cases, regression evidence | Evidence from executed checks; test-file mutations explicitly scoped |
| Reviewer | Independent diff review, maintainability, conventions, architectural compliance | Findings distinct from QA; normally read-only |
| Security | Threat analysis, vulnerability checks, access-policy review | Infrastructure enforces permissions; this agent assesses them |
| Performance | Profiling, reproducible baselines, optimization recommendations or scoped fixes | Distinguish measured findings from static hypotheses |
| DevOps | Local environments, build/CI workflows, migration and rollout preparation | Beta has no autonomous production deployment |
| Technical Writer | API/maintainer documentation, ADRs, release notes | Derive documentation from approved requirements and delivered artifacts |

Adapt the vision rather than copying it verbatim: PM's stated "26 skills" must
be inventoried, Gherkin/INVEST and AST tools are techniques rather than universal
requirements, frozen contracts are revisable with history, and parallel patch
integration is deferred. Security checks do not grant capabilities. UX/UI
implementation can be assigned to Developer, but design responsibility for new
products still needs a later decision. Beta does not promise automated design.

Roles are responsibilities, not fixed models or permanently running agents.
Select specialist participation according to the task. Technical repair
escalation remains execution policy, not additional public business roles.

## Milestones and dependencies

| ID | Reviewable increment | Prerequisites |
| --- | --- | --- |
| M0 | Beta contracts, scope decisions, baseline and screen inventory | This plan |
| M1 | Real read-only kanban and initial event correlation | M0 |
| M2 | Persistent direct tickets and attachments | M1 |
| M3 | PM Intake, minimum persisted plan, branch preparation, direct-task execution | M2 |
| M4 | Nine-role delivery pack and versioned pipelines | M3 |
| M5 | OpenAI model settings and effective configuration history | M0; UI after M1; integrated with M4 |
| M6 | Read-only Jira/Confluence Intake and internal tracking | M2, M3, M4 |
| M7 | Operator controls, human review, and authorized Git delivery | M4; exercised with M6 |
| M8 | Complete beta screens, telemetry quality loop, MLflow experiment | M1 onward; final gates after M4-M7 |
| M9 | Release candidate, recovery validation, pilot, beta packaging | M1-M8 |

M1, M2, and M3 remain separate releases of functionality. Bounded backend,
interface, and integration tasks may proceed in parallel after contracts are
stable; shared file ownership and integration stay under the lead.

### M0: Establish executable boundaries

Deliverables:

- Record ticket/run/assignment identity, projected statuses, field ownership,
  acceptance disposition, and lifecycle command contracts.
- Produce the nine-role contracts, PM/lead mapping, tool/skill inventory, repair
  routing policy, and project execution/branch isolation decision.
- Record the owner's Jira write decision: external writes deferred; read-based
  Intake and internal tracking retained. Do not infer publication authority
  from an issue link. See O-06 in [decisions](m0/decisions.md).
- Define supported beta Jira types/actions, authentication configuration,
  attachment formats/limits, initial presets, and model configuration pinning.
- Extract the prototype screen by screen: shell, Board, ticket forms/detail,
  Pipelines, Monitor, Decisions, Docs, Connections. Account for each control,
  its source handler, simulation replacement, contract gap, and deferred status.
- Verify an independent working copy exists at `web/dashboard/**`. Establish a
  reference-integrity baseline and keep it unchanged throughout implementation.
- Run the existing relevant suite as a baseline; distinguish actual passes,
  failures, and environment skips. Establish representative pilot repositories
  and tasks, without mutating them during planning.

Exit gate: contract artifacts and initial backlog exist; each unresolved choice
has an owner and a milestone that must resolve it. No UI simulation is silently
treated as backend functionality. Coverage checks count control identifiers,
not semantic correctness; report both their result and this limitation.

### M1: Observe real work first

Deliverables:

- Serve the integrated UI from the application copy, with an authenticated
  same-origin read API for real tasks,
  details, roles, attempts, and available usage. Document browser-session handling
  without exposing the server bearer token in shipped assets.
- Implement a compatibility view for existing runs and coarse A2A statuses.
- Connect Board cards, filters, search, and read-only ticket detail to real data.
  Remove role-enable switches from the integrated sidebar. Keep mutations
  unavailable with clear explanations until their milestones land.
- Establish correlated lifecycle events from startup, submission, dispatch,
  completion, errors, and recovery. Start with polling if sufficient; add a
  resumable live stream only when its event contract is ready.

Exit gate: a run submitted through the existing CLI appears, progresses, and
survives browser reload/server restart in the board. Empty, failed, paused, and
unknown states render honestly. UI observation creates no execution side effects.

### M2: Store direct requests

Deliverables:

- Introduce durable product tickets, requirement revisions, artifacts, and
  links to later runs. Add validated create/read/update draft commands and
  migrations with backup/upgrade instructions.
- Wire New Ticket title, description, acceptance criteria, priority, references,
  and attachment storage. Publish the supported extraction matrix, starting
  with essential text/Markdown and images; explicitly mark PDF/DOC/DOCX support
  until an extractor is verified. Never represent a saved filename as read content.
- Show the configured target project, input source, and work-tracking intent.
  Internal tracking is the default for direct requests. Role selection expresses
  the requested specialty; PM remains the coordinating entry point.
- Separate Save from Start/Submit to Intake. Form status choices cannot create
  fake in-progress or done executions. Define allowed manual backlog transitions.

Exit gate: a direct ticket and its files survive reload/restart, retain references,
and do not start execution until explicitly submitted. Repeated submission does
not duplicate the ticket or run; validation errors remain actionable.

### M3: Execute a direct task through Intake

Deliverables:

- Implement the PM coordinating entry point and normalize submitted material
  into requirements with provenance, unknowns, scope, and expected outcomes.
- For this first increment, configure the existing lead as the PM-facing
  coordinator, using the contract/mechanism settled in M0. Route implementation
  to `orch-builder`, independent checks to `orch-verifier`, review to
  `orch-auditor`, and investigation/design to the existing read-only roles when
  needed. Preserve repair prerequisites and expose the effective runtime IDs.
  M4 introduces the complete business-role pack; M3 does not claim it exists.
- Gather bounded repository context. Ask for human input only where missing
  information materially changes the deliverable or required authority.
- Define readiness and acceptance checks, classify work, and prepare the task
  branch through a deterministic Git adapter. Branch names are project policy.
  Dirty checkout/branch collisions get explicit handling; no implicit stash,
  reset, or deletion of user work.
- Persist a minimal versioned implementation/review/check plan, concrete stages,
  dependencies, assigned scopes, and acceptance checks before dispatch. Validate
  it and use the explicit interim role mapping. Pin the input revision and
  repository context. M4 generalizes this plan into the preset registry rather
  than introducing plan persistence for the first time.
- Deliver a diff and evidence for human review. Record rework against the same
  ticket; commit/push remain protected until M7.

Exit gate: one direct bugfix and one direct feature reach review with inspectable
changes, prior saved plans, and actual acceptance evidence. Insufficient requirements produce a
specific waiting state. A failed model/check cannot be reported as accepted work.

### M4: Activate the delivery team and pipeline model

Deliverables:

- Activate all nine validated role contracts in a separate delivery pack. Map
  public display names to runtime IDs without bypassing current catalog, sandbox,
  repair, and worker-report validation.
- Implement versioned preset definitions and saved task-specific stage plans.
  Start with feature, bugfix, docs, and audit. Add security, performance,
  environment, and debt routes only after their contracts and pilot cases exist;
  unsupported routes are explicitly unavailable.
- Record concrete assignments, stage IDs/dependencies, expected evidence, and
  role participation. Validate dependencies, cycles, scopes, and required gates.
- Relate bounded lead rounds/retries to stage progress. A revised plan keeps its
  parent, reason, completed evidence, and decision history. Block dependent work
  after a failed prerequisite until an authorized recovery transition occurs.
- Drive Pipelines from saved plans and actual attempts, not sample state.

Exit gate: a task has an inspectable plan before engineering dispatch; normal,
failed, retried, skipped, and revised stages remain consistent with Attempts and
Board. QA/Reviewer decisions cannot be fabricated by the implementing role.
Each of the nine roles has a reproducible capability check or representative case.

### M5: Make OpenAI defaults configurable

Deliverables:

- Fetch model/capability metadata from installed Codex App Server, save per-role
  defaults, validate model identifiers and reasoning efforts, and handle catalog
  errors or unavailable selections explicitly.
- Support Fast/service-tier selection only when advertised and usable. Keep
  effort and speed separate; catalog presence alone is not account entitlement.
- Present actual Codex OAuth connection/account health. Replace simulated
  connect/handshake behavior. No other provider is offered as connected.
- Persist effective model, effort, tier, role/prompt version, and settings revision
  for each run/attempt. Editing defaults does not hot-reconfigure active work.

Exit gate: changing a role default affects a new run, appears in its history, and
does not alter an existing/resumed run. Invalid or unsupported choices are rejected
before dispatch. Include PM configuration rather than leaving its model hardcoded.

### M6: Bring Jira and Confluence into the same flow

Deliverables:

- Implement scoped connectors and credential configuration appropriate to the
  owner's Jira/Confluence deployment. Save references and revision metadata.
  Use explicit source access; inaccessible links remain visible as missing context.
- Import issue body and relevant comments, parent/epic, and linked Confluence
  content within bounded traversal. Preserve exact external issue identity.
- Normalize into the same PM Intake and ticket model as direct requests.
- Keep all external write controls unavailable. Linked internal tracking is the
  beta mode; read connector capabilities/credentials must not grant publication.
  Repeated imports preserve identity and avoid duplicate internal tickets/runs.
- Preserve imported revisions and detect changes by Jira users. Refreshing source
  context is an explicit input revision, not a silent overwrite of active work.
  Local completion never claims Jira status was updated.

Exit gate: one Jira feature and one Jira bugfix pass Intake with inspectable source
provenance. Test missing epic/page, expired credentials, external edits, and
repeated requests. Verify no issue/comment/status/publication request occurs.
A Jira outage does not erase internal progress.

### M7: Give the operator real control

Command semantics established in [M0 contracts](m0/contracts.md), implemented here:

| Command | Intended effect |
| --- | --- |
| Pause | Stop new dispatch; show pause requested until active work settles safely |
| Resume | Continue the saved run/revision after validating recovery conditions |
| Stop run | End this run, reconcile active work, retain ticket and evidence for another run |
| Cancel ticket | Close the ticket and request cancellation of associated work |
| Edit | Edit drafts; stage a new revision for active work and apply it only at a safe boundary |
| Return to Backlog | Settle active work and return the ticket for specification, retaining history |
| Review / request corrections | Record the inspected result revision and create bounded rework |
| Commit / push | Perform an explicitly authorized Git action on the reviewed candidate |

Deliverables:

- Implement guarded, idempotent commands and pending states. Do not claim paused
  or stopped while a writer is still executing or its outcome is unresolved.
- Bind human decisions to the ticket, run, input/plan revision, and exact candidate.
  A changed candidate invalidates old delivery authorization.
- Implement commit/push in a deterministic scoped Git service, not by letting
  arbitrary agents mutate Git state. Show the target branch/remote and included
  changes; retain outcomes and retry reconciliation. No automatic PR creation.
- Make drag/drop a permitted lifecycle request where agreed; reject invalid
  transitions and revert the visual move to authoritative backend state.

Exit gate: controls work during queued, active, waiting, paused, failed, and
completed states. Cancellation retains existing file changes and evidence rather
than implying rollback. Unauthorized commit/push and stale approvals have no
effect; an authorized reviewed candidate can be committed and pushed.

### M8: Finish the application views and learning foundation

Deliverables:

- Complete Monitor filters, reconnect behavior, and real correlated logs.
  Clear Log clears the view only; immutable audit evidence is preserved.
- Complete Decisions with real pending actions and version-bound responses;
  Docs reads actual role/preset/project artifacts rather than embedded examples.
- Complete ticket Run Log, Turns/events, Attempts, and Tokens views. Show available
  activity and outputs without promising hidden model reasoning. Distinguish
  measured usage, unavailable monetary cost, and optional hypothetical API cost.
- Expose cached input-token count/share by role, ticket, and run, with partial-data
  coverage and unavailable states as defined in telemetry-mlflow-notes.md.
- Attach human review, acceptance evidence, and rework to versioned executions.
- Run the bounded MLflow integration experiment: send representative sanitized
  traces, preserve correlation, attach outcome/feedback, and test exporter failure.
  Record an adopt/defer decision and verified deployment/configuration steps.
- Curate a small evaluation dataset and compare at least one prompt candidate
  to a baseline using real deterministic quality evidence. Model judges are
  optional and require separately configured model access. Run mutation-capable
  evaluation cases in isolated test workspaces. No automatic live promotion.

Exit gate: all six tabs support their beta contracts with real/explicitly absent
data. MLflow has a documented experiment result. If it is deferred for a concrete
integration limitation, local telemetry and evaluation evidence remain available
and the deferral is visible in release notes; do not silently claim integration.

### M9: Prove and package beta

Deliverables:

- Run the focused existing/regression suite, new API/lifecycle/integration tests,
  and browser acceptance against the exact release candidate.
- Perform bounded live OpenAI pilots, clearly separating fake-protocol test
  evidence from real model execution. Use representative tasks with known outcomes.
- Verify startup/upgrade, state backup/restore, process interruption, repository
  reconciliation, and resume. Document supported Node/Codex versions actually tested.
- Audit authentication, external-operation scopes, attachments/Markdown rendering,
  credential handling, and the absence of protected-action bypasses.
- Verify the protected dashboard reference still matches its baseline. Application
  build and runtime paths must point to the working copy, not the reference.
- Prepare setup, operator guide, troubleshooting, known limits, changelog, and
  release checklist. Preserve pending work when migrating state.
- Review the beta candidate against the checklist below. Prepare a version/tag
  proposal and release notes; publication/merge occurs under the owner's release
  authority, not merely because this planning request exists.

Exit gate: no unresolved critical defect in the primary flows, command lifecycle,
data durability, repository ownership, or protected actions. Remaining limitations
are explicit, and documented procedures support reproducing both primary scenarios
from a clean setup. Repeated owner-run validation across varied Jira tasks,
including epic and Confluence context where available, is a follow-up for the next
live project and is not an M9 exit gate.

## Release acceptance checklist

The cases below define expected behavior. The M9 acceptance ledger records the
evidence and disposition for this candidate; future live-project validation is
identified separately from the M9 exit gate.

| Case | Required result |
| --- | --- |
| Direct ticket | Save, reload, Intake, implementation, independent checks, human review |
| Jira ticket | Jira issue provenance and the same delivery lifecycle. Full-cycle validation of epic and Confluence context is deferred to the next live-project pilot and is not an M9 exit gate. |
| Tracking intent | Both sources use internal tracking; read-only connectors never publish to Jira/Confluence |
| Nine roles | Valid role contracts and real participation/capability evidence |
| Pipeline | Saved plan before dispatch; history survives retries and revisions |
| Acceptance | Failed/unavailable checks never produce a falsely verified result |
| Corrections | Human findings cause bounded rework and a new reviewable candidate |
| Protected Git | Branch lifecycle is owned; commit/push require candidate-bound authorization |
| Pause/stop/cancel | No further unauthorized dispatch; active effects reconciled |
| Edits/backlog | Input revisions and previous run evidence retained |
| Restart | Ticket/plan/attempt history retained; interrupted writer settled before new writes |
| Duplicates/stale results | No duplicate run or protected effect; stale decisions rejected |
| Repository concurrency | Tickets cannot cross branch/context boundaries in a shared checkout |
| Model settings | Catalog validated; effective settings recorded and pinned |
| Usage/cache | Known/unknown/partial values distinct; cached share computed over paired counts |
| Six tabs | Real backend behavior, empty/error states, and reconnect/reload behavior |
| Credentials/content | No secret trace payloads or untrusted-content permission escalation |
| MLflow experiment | Reproducible result and explicit adopt/defer decision |
| Prompt comparison | Versioned candidate comparison with quality evidence; no live auto-rewrite |
| Installation/recovery | Tested setup, migration, backup/restore, and known limitations documented |

## Work organization

The lead owns architecture, contracts, backlog priorities, integration, and final
acceptance. Use scoped workers for product code/tests/config, read-only explorers
for evidence extraction, and independent auditors for consequential flow changes.
Every implementation ticket names allowed files, dependencies, output contracts,
acceptance cases, and checks. Workers preserve others' edits and report needed
scope expansion. Repository Git state remains under the lead/operator rules.

Maintain a milestone backlog with `planned`, `in_progress`, `review`, `blocked`,
and `complete` plus evidence links. No checklist is pre-marked complete. At each
milestone, record scope changes, assumptions resolved, risks remaining, and the
next demonstrable increment. Broad testing is justified by changed boundaries,
not by the desire to accumulate test counts.

M0 artifacts, baseline and requirement audit are recorded in [m0/README.md](m0/README.md).
The next increment is M1, using the [initial backlog](m0/backlog.md). Implementation
and release publication are subsequent work; M0 does not claim the UI integrated.
