# Dashboard integration plan

Recorded on 2026-09-30 from the project owner's discussion. This file preserves
the agreed direction for incremental integration of `artifacts/dashboard`.
It records planning decisions, not completed implementation.

The owner's primary Jira delivery scenario and long-term team objectives are
recorded in [product-goals.md](product-goals.md).
The implementation roadmap through the first beta is
[beta-master-plan.md](beta-master-plan.md). It supersedes earlier role-roster
discussion below as the current planning baseline, while distinguishing
recommendations from finalized contracts.

## Agreed direction

M0 confirms read-only Jira/Confluence retrieval with internal work tracking for
beta; all external publication is deferred. The contracts, nine-role boundaries,
screen inventory and verification are indexed in [m0/README.md](m0/README.md).

- Keep the existing eight `orch-*` worker roles on `main`.
- Develop dashboard integration on `feature/dashboard-integration`, created
  from `main` on 2026-09-30.
- Use the existing HTML, CSS, and JavaScript prototype as the interface reference.
- Preserve `artifacts/dashboard/**` unchanged. Use an independent copy at
  `web/dashboard/**` for integration and builds. This owner instruction is
  enforced as a project rule in [AGENTS.md](../AGENTS.md) and
  [CLAUDE.md](../CLAUDE.md).
- Integrate incrementally: first the kanban board showing real tasks, then task
  creation, then Intake and subsequent features in separate steps.
- Support OpenAI only in the initial integration. The owner later identified
  Claude as a future extension and Gemini as a possible frontend executor.
  Neither is part of the initial implementation scope.
- The prototype roles began as placeholders. After discussing the owner's
  delivery goals, the lead endorsed all nine as the starting roster. The owner's
  embedded `Role-Definitions.md` is their editable vision; detailed responsibilities,
  permissions, and runtime mappings remain to be specified.

## Proposed implementation approach

Read the role roster and task states from the backend rather than maintaining a
separate fixed roster in the UI. Display names may differ from internal role IDs.
The initial board can display the server's existing team before the business-role
pack is introduced. These are implementation proposals, not a completed technical spec.

## Battle Pass exclusion and deferral

The owner created Agent Battle Pass as a joke for colleagues and a possible
gamification feature: completed tasks could award experience and unlock
achievements. The mock payment, subscription, and paid performance claims are
illustrative jokes, not product requirements. There will be no donations,
payments, or monetary transactions in Battle Pass.

Do not modify, implement, or plan Battle Pass until the dashboard is complete
as a fully functioning application integrated with OpenAI. Preserve the existing
prototype for now. Any later gamification work requires a separate discussion
after that milestone; it is not part of the current dashboard implementation.

## Sidebar role controls

The owner decided that per-role enable/disable switches do not fit the autopilot
experience: the team operates as a unit. Remove the illustrative role switches
from the integrated interface. This does not require every role to execute on
every task; role participation follows the task's workflow.

No replacement control is required. A proposed optional replacement is an
activity indicator derived from actual executions, alongside the existing role
name and task counts. Such an indicator would display state rather than change
routing. The exact semantics of any future team-wide start, stop, or pause
control remain undecided.

## Decisions still open

- Detailed contracts, permissions, and routing for the nine-role starting roster.
- Whether a board card represents a user task, a run, or a worker assignment,
  and how these levels relate in the interface.
- The real semantics of the prototype's drag-and-drop status changes.
- The task creation and Intake contracts.
- How a task's initial pipeline is selected or planned, validated, and revised.

## Pipeline intent under discussion

The owner described the Pipelines tab as progress tracking for concurrent tasks,
each with a flow defined before execution. The prototype illustrates this with
two records in `artifacts/dashboard/js/state.js:376-397`, rendered by
`artifacts/dashboard/js/tabs/pipelines.js:2-35`. Its current records contain
pipeline IDs, names, and role/status steps; they do not link to ticket IDs or
implement execution.

This is feasible as a later feature. The current backend plans assignments round
by round rather than persisting a complete task-specific pipeline in advance.
The pipeline planning and execution contract remains undecided. This discussion
does not expand the first kanban milestone.

## Presets proposal under discussion

The prototype's `Delivery-Pipelines.md` entry lists eight named subsets:
`feature`, `bugfix`, `security`, `performance`, `environment`, `debt`, `audit`,
and `docs` (`artifacts/dashboard/js/state.js:629`). The Docs tab displays this
text; it does not register executable presets (`artifacts/dashboard/js/tabs/docs.js:2-35`).
Their role names remain illustrative, as agreed above.

The proposed approach is to define reusable, versioned presets in advance and
select one during Intake. The selected preset would be instantiated into a
task-specific plan with concrete assignments and completion criteria, validated
and saved before dispatch. Automatic preset selection is distinct from creating
an arbitrary new plan.

For tasks that do not fit a preset, the lead could propose a custom plan subject
to the same validation and required checks. Changes during execution would be
recorded as a new plan revision without erasing completed attempts. The decision
between fixed templates, custom plans, or this combined approach remains open;
none of the prototype routes is approved as a mandatory workflow yet.

## Model settings direction

The owner wants role models to be discoverable and editable through the web UI,
with provider, model, reasoning effort, and speed controls. The example is
`OpenAI / gpt-6.1-sol / High / Fast off`. Here `High` denotes reasoning effort;
speed is a separate setting. The prototype currently hard-codes model lists and
uses `max`, `elevated`, and `default` as effort labels
(`artifacts/dashboard/js/tabs/connections.js:3` and `:244-248`). Those labels must not
be passed to Codex as reasoning-effort values without explicit translation.

Proposed implementation: obtain model and capability metadata through Codex App
Server `model/list`, persist defaults per role, validate selections, and resolve
settings for each new execution. Preserve the effective settings in execution
history. Changing defaults should not modify an already running turn; the exact
rules for pending assignments and resumed runs remain open. Automatic selection
of a model for each task is a separate future routing policy, not implied by a
dynamic model catalog or an editable default.

The installed Codex CLI 0.159.0 generated experimental protocol types confirming
`supportedReasoningEfforts`, `serviceTiers`, and `defaultServiceTier` on `Model`,
and `model`, `effort`, and `serviceTier` on `TurnStartParams`. No inference request
was made to verify account access. A catalog entry alone is not proof of access.
The project currently forwards model and effort, lacks speed handling and a model
settings API, and loads profiles at startup. Its current model-name validator
also excludes dots, so the example `gpt-6.1-sol` needs a validation change.

Official references checked on 2026-09-30:
[Codex App Server](https://learn.chatgpt.com/docs/app-server) and
[Codex speed settings](https://learn.chatgpt.com/docs/agent-configuration/speed).

## Task lifecycle controls under discussion

The owner expects task-level operator controls for Pause/Resume, Stop, Cancel
Task, Edit Ticket, and Return to Backlog. The prototype implements these as
in-memory ticket mutations and modal navigation
(`artifacts/dashboard/js/modals/ticket-modal.js:517-605`); it does not control
real executions.

The backend already supports cancellation, human-decision waits, and resumption
of supported paused or interrupted lead runs. It does not implement an arbitrary
operator pause, a separate Stop transition, editable task revisions, or Return
to Backlog. Pinned acceptance checks cannot be changed by a resume message.

Proposed semantics, awaiting a product decision:

- Pause prevents further dispatch at a safe boundary, with a visible pending
  pause while an existing execution settles. Resume continues the saved plan.
- Stop ends the current execution/run while retaining the ticket and results
  for subsequent editing or another run.
- Cancel closes the ticket and requests cancellation of associated work.
- Edit changes a draft freely; changes affecting running work produce a new
  requirement/plan revision after the previous execution settles.
- Return to Backlog stops further work, settles active executions, and returns
  the ticket for specification without erasing its run history.

Operator commands must be validated lifecycle transitions. Cancellation or
stopping does not automatically undo file changes. The precise pause behavior,
Stop versus Cancel distinction, edit rules, and restart semantics remain open.
These controls belong to later milestones, not the first observation board.

Implementation must resolve these from the relevant prototype handlers and the
owner's requirements when each feature enters scope. Prototype simulations alone
do not establish backend behavior.
