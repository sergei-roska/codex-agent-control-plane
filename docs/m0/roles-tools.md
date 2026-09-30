# M0 role contracts and reuse inventory

Status: beta implementation contracts, not an activated role pack. Owner vision:
`artifacts/dashboard/js/state.js:633-634` (embedded Role-Definitions.md).
Current execution pack: `profiles/TEAM.md`, `profiles/agents/*.toml`.

## Common assignment contract

Every assignment pins ticket/run/requirement/plan/stage IDs, role-pack version,
objective, input artifact revisions, allowed paths, allowed tools, expected
outputs, acceptance checks, budget, and stop/escalation conditions. Results use
validated structured reports plus immutable artifact references. Record actual
checks, findings, limitations and scope-expansion requests; silence is not success.
The coordinator inspects evidence before accepting a result. Failed prerequisites
block successors. A specialist cannot approve its own implementation as delivery.

Roles are public responsibilities. Models and temporary repair executors are
configuration/execution policy, not additional public roles. Specialist activation
is selected by a validated task plan, not individual sidebar enable switches.
No nine-role runtime is claimed until M4 validates its catalog and capability cases.

| Role ID | Inputs and responsibility | Required outputs | Authority and boundaries |
| --- | --- | --- | --- |
| project-manager | Submitted ticket, accessible sources, project policy; normalize requirements, resolve business unknowns, readiness, coordination | Versioned requirements with provenance, scope/DoD, clarification decisions, ready/not-ready reason, delivery report | Sole coordinating lead; dispatch only validated scopes; read-only repository; no specialist self-approval or Git/external writes |
| architect | Ready requirements, repository evidence; technical decomposition, contracts, impact analysis | Technical plan, dependency/scoped assignments, design decisions and risks | Read-only by default; proportional involvement; PM retains business ownership |
| developer | Validated technical scope, pinned inputs and checks | Owned delta, focused test results, implementation report and limitations | Writes assigned product files only; no Git state, deployment, external publication, permission bypass or self-approval |
| qa | Exact candidate and requirements, acceptance/check policy | Independent behavior/regression evidence, reproducible failures and check artifacts | Execute approved checks; test-file changes only explicitly scoped; acceptance based on executed evidence |
| reviewer | Exact diff, project conventions, technical contract | Independent findings with severity/location, approval or rejection with evidence | Normally read-only; fixes go to Developer or separately scoped assignment |
| security | Threat surface, candidate and access policy | Vulnerability findings, trust-boundary review, remediation/verification evidence | Read-only by default; does not grant permissions or replace backend enforcement |
| performance | Known scenario, baseline and candidate | Reproducible measurements and recommendations, or labeled static hypotheses | Approved bounded profiling; fixes require explicit scope; no invented improvement claims |
| devops | Project environment/build requirements, approved local operations | Reproducible setup/build/CI/config evidence, migration/recovery instructions | Assigned configuration/scripts only; no autonomous production deployment or credential disclosure |
| tech-writer | Approved requirements, delivered candidate and verified behavior | Maintainer/API documentation, ADRs/release notes, verified examples/links | Assigned documentation only; cannot redefine implementation or claim unverified behavior |

Business task decomposition belongs to PM; technical decomposition and contracts
belong to Architect. Developer handles implementation of existing frontend designs.
New-product UX design ownership is post-beta decision U-06, not a tenth beta role.
DoD/check depth is proportional to task risk; Gherkin, INVEST and AST tools are
optional methods rather than requirements for every request.

## PM mapping and repair routing

M3 changes coordinating lead instructions through explicit configuration to PM
responsibility while preserving its read-only boundary. Interim public-to-runtime
mapping: Developer -> orch-builder, QA -> orch-verifier, Reviewer -> orch-auditor,
technical investigation -> orch-explorer, narrow technical second opinion ->
orch-architect, mechanical inventory -> orch-scout. M3 exposes these effective
runtime IDs honestly. Security, Performance, DevOps and Writer are not silently
advertised as activated legacy roles; their full contracts become selectable M4.

M4 supplies a separate delivery pack and validated business-role routing. Legacy
orch profiles retain existing behavior. Tool/capability policy, sandbox and report
validation apply before dispatch. Do not turn the PM into a second planner beside
the existing lead; it is the lead's configured business responsibility.

Implementation starts with Luna high (current orch-builder). On a concrete failure,
the lead reviews evidence and sends a harder bounded retry to Luna xhigh
(orch-repair-xhigh). Only after Luna still cannot complete correctly does Sol
(orch-repair-sol) become eligible. An architecture opinion uses orch-architect
only after a consequential unresolved question has been investigated. Repair
retains Developer's public assignment responsibility and independent QA/Reviewer
gates. A repair cannot expand paths, budgets or permissions without lead-approved
contract revision. Counters and budgets remain bounded; denial is never bypassed.

## Existing assets and gaps

Inventory is filesystem evidence, not proof of live tool availability. Current
profiles explicitly use `mcp_servers = []` and `skills = false`
(`profiles/agents/orch-builder.toml:15-17`). M0 does not install or run these tools.
The claimed 26 PM-specific skills were not verified; an inspected earlier pack
lists 30 skills across roles, not 26 PM skills. Reuse requires license/instruction,
capability, platform and permission checks plus a focused representative case.
Current deterministic repair guards (`src/contracts.js:284-288`) require the
prior role to have been attempted, not proof of its failure. The concrete-failure
and evidence-review routing above is the beta policy to enforce/verify in M4;
M0 does not claim the stronger guard already exists.

Generic role candidates below are under
`/home/sr/Projects/ai-project-orchestrator/ai-project-orchestrator/skills/`:

| Role | Candidate SKILL.md path relative to that directory |
| --- | --- |
| PM | project-manager/SKILL.md |
| Architect | architect/SKILL.md |
| Developer | backend-developer/SKILL.md; frontend-developer/SKILL.md |
| QA | qa-engineer/SKILL.md |
| Security | cross-functional/roles/security-engineer/SKILL.md |
| Performance | cross-functional/roles/performance-engineer/SKILL.md |
| Writer | cross-functional/roles/technical-writer/SKILL.md |

Additional inspected candidates:

- PM/Architect: that repository's `packs/insomniac-drupal/skills/start-ticket`,
  `write-spec`, `decompose-task`; grants in `pack.yml:347`.
- PM/handoff: `ws-knowledge/skills/agent-factory/SKILL.md`,
  `agent-forge/skills/dev-testcode/SKILL.md` and `ticket-handoff/SKILL.md` under
  `/home/sr/Projects/Workspace`.
- Reviewer: `/home/sr/Projects/Workspace/ws-knowledge/workflows/review.md:1`
  and prior Drupal auditor instructions. No generic Reviewer skill is assumed.
- DevOps: provision-local-platform, config-deploy-gate and release-manager;
  Security/Performance: cacheability-access-auditor,
  performance-maintainability-drupal and query-performance-investigator.
  Drupal-specific candidates need project-type gating, not universal activation.

Agent Forge manifests under `/home/sr/Projects/Workspace/agent-forge/servers/`
declare drupal-codebase-introspect, drupal-testing, drupal-runtime-inspect,
drupal-render-theming, drupal-operations-debug, drupal-content-model,
drupal-config-intelligence, drupal-sandbox, local-memory-search,
local-memory-indexer and web-observe-capture. Each has server.manifest.json;
for example `drupal-codebase-introspect/server.manifest.json:2` identifies its ID.
MCP Forge's `mcp-servers-dev.json:2` lists seven Drupal server placeholders;
neither catalog proves installation, credentials or live readiness.

No inspected catalog establishes a configured Jira/Confluence retrieval adapter.
Earlier `pack.yml:337` has optional tracker-read intent; `app/intake.py:27` routes
labels and `app/delivery_workflow.py:691` records tracker intent rather than
dispatching the complete connector workflow. M6 must implement/validate retrieval.
Choose tools by needed capability and target stack, not by the presence of a file.

## Activation checks

M4 must exercise each role's structured result and authority boundary. PM produces
ready/not-ready provenance; Architect produces scoped dependencies; Developer
returns a bounded delta; QA catches a seeded failing behavior; Reviewer detects a
seeded contract violation; Security identifies an unsafe access boundary;
Performance distinguishes measured evidence from a hypothesis; DevOps reproduces
approved local setup; Writer verifies an example against delivered behavior.
These are future validation obligations, not M0 test results.
