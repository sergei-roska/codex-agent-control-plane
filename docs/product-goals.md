# Dashboard and delivery team goals

Recorded from the project owner's explanation on 2026-09-30. The initial product
goal is to deliver Jira issues and directly submitted dashboard tickets through
a visible agent workflow. The long-term goal is to manage the product and
engineering lifecycle of both new
projects and existing systems. This is product direction, not an implementation
specification or a finalized role roster.

## Primary delivery scenario

1. The owner supplies a Jira issue key, such as `JIRA-123`, or creates a direct
   task through the dashboard's New Ticket modal.
2. The team gathers requirements and relevant project context from the submitted
   description, references, and attachments. For Jira issues, this includes the
   issue, its parent epic, and linked Confluence specifications where present.
3. The team identifies the kind of work, such as a bug or feature, and creates an
   appropriate working branch. The owner's example is `feature/jira-123`; exact
   naming rules remain to be defined per project.
4. The team decomposes the work, defines the Definition of Done and acceptance
   checks, and carries out the issue.
5. The owner reviews the result and requests corrections if needed.
6. After a satisfactory review, the owner explicitly requests commit and push.
7. The owner creates the pull request.

These are the two primary early entry points. The user-facing task is
the delivery request; it may contain multiple agent assignments and runs.
The exact mapping between these entities remains a design decision.

## Intake source and work tracking

The owner distinguishes task input from the intended place of work tracking.
Jira is not the only input source. Direct dashboard tickets should enter the
same orchestration process once intake has established usable requirements.
The submitted material should identify the expected outcome and target project;
the PM can organize supporting documentation and clarify missing requirements.

Proposed tracking choices are internal dashboard only, or internal dashboard
with linked Jira tracking. A direct ticket may reference Jira or Confluence as
context without requesting Jira writes. Linking an existing Jira issue and
creating a new Jira issue are distinct operations. The UI should express the
tracking intent using explicit fields or project defaults rather than relying
on the PM to infer it from uploaded documentation.

Beta decision confirmed by the owner during M0: Jira and Confluence are read-only
sources; all work is tracked internally. No issue creation, comments or status
writes are included. Linked Jira tracking/publication is a future product option.
See [M0 decisions](m0/decisions.md), O-06.

Internal tracking is the beta mode for direct tickets. Jira-origin tasks
retain their external issue reference; reference alone does not define allowed
external updates. Integration synchronization, ownership of editable fields,
and external action permissions belong to the later write integration. Tracking location
does not change the target repository or imply a different engineering workflow.

## Long-term objective

The team should eventually support an IT company's product and engineering work:
create epics, plan sprints, create and maintain tasks, move projects through the
internal dashboard and Jira, maintain documentation, and deliver working sites
or applications. It must support development of new projects and maintenance
of existing ones.

Humans should be able to configure external integrations and their credentials
through an administration interface, including services such as Confluence,
Google Tag Manager, and CAPTCHA providers. The owner is prepared to develop
skills, rules, and MCP servers and authorize the integrations needed for these
workflows. Concrete adapters and action permissions remain to be designed.

The owner approved automatic background telemetry from the early integration
stages, a bounded evaluation of MLflow, and later prompt optimization based on
data and quality criteria. A background system analysis agent outside the
delivery roster is under discussion. See
[telemetry-mlflow-notes.md](telemetry-mlflow-notes.md). The remaining work,
including OpenTelemetry instrumentation, is planned in the
[observability and prompt optimization backlog](observability-optimization-backlog.md).

## Existing assets named by the owner

- `/home/sr/Projects/Workspace/ws-knowledge/skills`: accumulated agent skills.
- `/home/sr/Projects/Workspace/ws-knowledge/workflows`: Bash workflow automation,
  some of which the owner still uses.
- `/home/sr/Projects/Workspace/agent-forge`: MCP tooling and related skills.
- `/home/sr/Projects/Workspace/mcp-forge`: tooling intended to match the target
  project's implementation language.
- `/home/sr/Projects/cursor-insomniac-subagent` and
  `/home/sr/Projects/Workspace/agent-factory`: prior team/orchestration work.

These are candidates for reuse, not assumed installed dependencies of this
orchestrator. Their production readiness has not been established by this file.

## Findings from the initial asset review

The inspected packs contain reusable intake and delivery instructions:
requirements with source provenance, dependency-aware decomposition, scoped
specialist assignments, and independent validation. See
[start-ticket](../../../cursor-insomniac-subagent/cursor/skills/start-ticket/SKILL.md)
and [decompose-task](../../../cursor-insomniac-subagent/cursor/skills/decompose-task/SKILL.md).
The existing Bash workflows also implement branch creation and push mechanics
in `ws-knowledge/workflows/feature-start.sh` and `feature-push.sh`.

The inspected Agent Forge and MCP Forge catalogs did not establish a configured
Jira and Confluence retrieval integration or the complete primary delivery
scenario. This is a bounded review finding, not a claim that no such integration
exists elsewhere. Existing shipping skills also use approval boundaries that
differ from the owner's target workflow; reuse requires adapting them to the
target workflow rather than inheriting those boundaries automatically.

## Nine-role starting roster

The owner proposed Project Manager, Architect, Developer, DevOps, Performance,
QA, Reviewer, Security, and Technical Writer to cover the delivery process. After
the goals discussion, the lead endorsed these nine as the starting roster for
the beta plan. The owner's `Role-Definitions.md`, embedded in
`artifacts/dashboard/js/state.js:633-634`, remains an editable vision.

Detailed role contracts and presets have not been finalized. Distinguish a role's
responsibility from its skills, tools, model, and number of executions. Additional
responsibilities for autonomous product planning and UX/UI design remain future
discussion items. See [beta-master-plan.md](beta-master-plan.md) for milestones,
scope recommendations, and release gates.

### Project Manager working hypothesis

The owner proposes Project Manager as the team's coordinating entry point,
combining requirements analysis and product management with delivery
coordination. This is a working role hypothesis, not a finalized contract.
Candidate responsibilities include intake from direct tickets, Jira, and linked
specifications, clarifying requirements and acceptance criteria, coordinating specialist
planning, tracking dependencies and progress, and presenting results and
unresolved decisions to the owner. Product priorities should follow the owner's
goals and explicitly delegated authority.

This combined role is a deliberate design choice for this system. It does not
assume that all IT companies assign product ownership, business analysis, and
project coordination to one position. Technical decisions and independent
quality checks still require their respective specialist responsibilities.

The existing eight `orch-*` roles remain on `main`. The dashboard branch and
incremental integration decisions are recorded in
[dashboard-plan.md](dashboard-plan.md).
