# Role authority, tools, and practical execution rights

Status: proposed policy for the concurrent engine. Existing owner-selected
execution policy remains authoritative until explicit integration of this design.
A role describes responsibility; a permission mechanism describes actual access.
Neither role text nor a successful model answer establishes enforcement.

## Common working contract

Agents resolve ordinary engineering uncertainty through evidence and act within
the objective. They can inspect relevant code/docs, use project-local toolchains,
run needed checks, and communicate findings to the lead. A missing fact triggers
investigation, not an automatic owner question. Two failed attempts at one premise
trigger reassessment rather than repeated identical work.

The lead chooses team composition, package size, ordering, review depth and repair
strategy. It can use a single worker for a small task or several instances of the
same role for independent work. No rule requires a particular role sequence merely
because a round ended. Model/effort/Fast and capacity settings remain owner choices.

Authority to execute tools is independent of authority to change another task's
source, Git state, external systems, requirements or budget. Missing external
credentials/access is a real boundary; absence of a globally installed tool is not
proof that the project-local toolchain is unavailable.

## Role capability matrix

All roles can read task-relevant evidence and report new facts. Scratch and generated
outputs below are attempt-scoped, not a grant to change shared product files.

| Role | Decisions and outputs | Product writes | Execution rights needed |
| --- | --- | --- | --- |
| Lead/coordinator | Objective, architecture, priorities, team/pipeline, backlog, routine scope decisions, acceptance judgment | Delegate product implementation; mutate planning state through validated controller APIs | Repository/doc inspection, evidence and capacity views, plan/control tools; interactive inbox remains available during worker execution |
| Explorer | Context maps, investigations, dependency/read-scope evidence | None | Read source/docs/services as authorized; scratch reports, caches and narrowly needed inspection commands |
| Engineer | Cohesive implementation and local verification | Assigned modules/files in private lane | Project package managers, builds/tests, assigned disposable services and outputs |
| Verifier | Independent executed checks and acceptance evidence | Scratch/new test proposals only; publication creates a new implementation candidate | Frozen candidate copy, build/test artifacts, temporary DB/ports; actual source/check mutations invalidate old-target certification |
| Auditor | Independent bounded risk/flow/integrity review | None | Frozen candidate, scratch probes, existing checks/builds when needed; writable scratch without product mutation |
| Recovery engineer | Evidence-based repair after failure | Assigned repair scope | Same practical toolchain access as engineer, preserved thread/context when valid |
| Senior engineer | Difficult implementation/repair | Assigned scope | Engineer capabilities with configured model/effort; no extra authority inferred from model strength |
| Architect | Narrow consequential design opinion | None | Read evidence and create scratch diagrams/probes; lead keeps final routine decision |
| Scout | Mechanical inventory and uniform inspection | None | Bounded reads and owned report/cache outputs |

Shared Git ownership belongs to one coordinator-assigned agent. Authorized local
Git operations, dependency setup and disposable test services are routine project
work. Push, publication, real external writes and destructive operations retain
their actual owner authorization boundaries.

## Separate source-write intent from sandbox mode

Current code often treats `sandbox !== read-only` as equivalent to product writer.
That is too coarse for an auditor who needs a test report or a verifier creating
build artifacts. The concurrent contracts need separate dimensions:

- `productWriteScope`: immutable task ownership and attested product changes.
- `scratchWriteRoots`: attempt-owned reports, caches and generated build outputs.
- `resourceClaims`: ports, disposable DBs/services and shared environment locks.
- `executionProfile`: the owner-selected native/strict policy and effective runtime.
- `publicationAuthority`: permission to publish a verified lane patch under admission.

A verifier with writable scratch is not automatically a product writer, and a
read-only source role is not prohibited from executing a test that writes to an
owned temporary directory. Strict mode must actually confine mounted source and
scratch; cooperative/native mode must accurately describe its limits and still
attest effects. Do not silently change the owner's execution-permission setting.

Capabilities are resolved before dispatch and pinned in the attempt contract.
Direct specialist entry points must enforce the same publication/claim semantics
or remain a clearly separate bounded legacy route. An agent cannot escape capacity
or source ownership by using a different endpoint.

## Restrictions that remain mandatory

Each mandatory restriction has a protected failure mechanism:

| Restriction | Protected failure |
| --- | --- |
| One active attempt per task revision unless explicitly a competing-candidate task | Duplicate effects from replay/claim races |
| No overlapping turns on one provider thread | Mixed conversation state and client rejection |
| Declared ownership and attested integration scope | One worker overwriting another's output |
| Serial shared-tree publication and reconciled unknown effects | Corrupted workspace and false effect attribution |
| Exact candidate/context/check identity for acceptance | Approval of code the reviewer never saw |
| Pinned owner checks and explicit requirement changes | Making tests pass by weakening the goal |
| Durable pause/cancel/control fences | Work publishing after a stop or resuming without authority |
| Finite configured capacity and bounded recovery | Uncontrolled usage and repeated non-progress |

Risk review is justified by the behavior being changed, not by a filename, number
of agents, end of a round, or a desire to find a defect. Existing mandatory legacy
review gates stay until their replacement is independently qualified. Routine
small changes can use lead inspection and relevant checks where the objective's
policy permits it. Record why extra independent review is needed or evidence is
reusable; do not require unnecessary standing audits.

## Owner availability and autonomy

The project UI must accept steering/status messages while workers run. Store
messages in a durable project/session inbox, acknowledge receipt independently of
worker completion, and prioritize relevant steering before new task claims. A
single logical lead can serialize short provider turns while continuously exposing
status and accepted-message state. A model reply may wait for its own current turn
or provider availability; it must not wait for the slowest worker's batch.

Owner corrections increment goal/authority/control revisions as appropriate.
Queued work is revalidated; active task output is preserved but cannot be accepted
under changed requirements without reconciliation. Show received, applied and
blocked message states distinctly. Do not claim that a queued message has already
changed an active task.

Acceptance includes a no-owner-intervention scenario: after an initial objective,
the lead coordinates independent work, detects/replans a recoverable failure,
keeps other work progressing, and reaches checked acceptance. A separate scenario
sends an owner correction while workers run and verifies its safe application.
