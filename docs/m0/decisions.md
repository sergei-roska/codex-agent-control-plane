# M0 decisions and boundaries

Date: 2026-09-30. Status: implementation planning baseline, not implemented code.
Owner decisions are identified separately from engineering defaults selected by
the lead. Change a default through a versioned decision before implementation
depends on it; do not present it as a requirement inferred from the mockup.

## Confirmed owner decisions

| ID | Decision | Authority |
| --- | --- | --- |
| O-01 | Protect artifacts/dashboard; implement in independent web/dashboard copy | Owner instruction and AGENTS.md |
| O-02 | Kanban observation first, then ticket creation, then Intake | Conversation and dashboard-plan.md |
| O-03 | OpenAI only; preserve current Codex ChatGPT OAuth adapter for beta | Conversation; beta-master-plan.md |
| O-04 | Jira issue and direct New Ticket are primary inputs | Conversation and product-goals.md |
| O-05 | PM coordinates requirements and delivery; nine roles are starting roster | Owner vision and lead endorsement; role contracts refine responsibility |
| O-06 | Jira/Confluence read-only and internal tracking in beta; Jira writes later | Explicit owner answer on 2026-09-30 during M0 |
| O-07 | Human reviews; commit/push require explicit request; human creates PR | Owner's primary scenario |
| O-08 | Automatic telemetry early; bounded MLflow experiment; later measured optimization | Owner acceptance; telemetry-mlflow-notes.md |
| O-09 | Report cached input counts and share with missing-data coverage | Owner acceptance; telemetry-mlflow-notes.md |
| O-10 | Remove individual role-enable switches; Battle Pass stays untouched/deferred | Owner instructions and dashboard-plan.md |

O-06 resolves the master's former optional Jira write branch. Beta has no issue,
comment, status, epic, sprint, or Confluence publication commands. External source
status is read-only context and must not mirror internal transitions automatically.

## Engineering decisions

| ID | Disposition | Decision and reason | Enforcement milestone |
| --- | --- | --- | --- |
| D-01 | Adopt | Keep CommonJS/Express, SQLite, A2A and LangGraph; current workload has no demonstrated migration need | M1 onward |
| D-02 | Adopt | Preserve modular HTML/CSS/JS and build in web/dashboard; no frontend framework migration in M1 | M1 |
| D-03 | Adopt | Product ticket is board entity; run/assignment/attempt are subordinate. Use explicit read-only legacy-run cards until product storage exists | M1/M2 |
| D-04 | Adopt | One configured repository per instance; a durable ticket-owned execution lease spans its entire mutation-capable run, not just one turn | M3 |
| D-05 | Adopt | Use the configured checkout serially in beta; prepare a branch only after readiness and clean-checkout preflight. No auto-stash/reset/deletion | M3 |
| D-06 | Adopt | PM is the one coordinating lead, not a second independent planner. M3 uses PM lead instructions and explicit legacy worker mapping; M4 activates delivery pack | M3/M4 |
| D-07 | Adopt | Persist a validated sequential/dependency plan before M3 dispatch; versioned preset registry in M4. Runtime retries remain bounded manager rounds | M3/M4 |
| D-08 | Adopt | Poll authenticated same-origin read API in M1; resumable SSE is deferred until an event replay contract is implemented | M1/M8 |
| D-09 | Adopt | Browser uses a local paired session, not a shipped A2A bearer. Keep current A2A authentication separate | M1 |
| D-10 | Adopt | Active/resumed runs pin model/settings/prompt/role/requirements/plan versions; defaults affect new runs | M3/M5 |
| D-11 | Adopt | Acceptance evidence and human review are separate; terminal A2A status is not product success | M1/M3/M7 |
| D-12 | Adopt | Local event journal is diagnostic state; execution tables/checkpoints remain authoritative. MLflow receives an optional derived export | M1/M8 |
| D-13 | Defer | Parallel developer checkouts/patch integration, broker, distributed deployment and vector memory | After beta, if workload requires them |
| D-14 | Defer | Background maintenance agent and automatic live prompt promotion | After curated quality evidence |
| D-15 | Evaluate | MLflow: bounded trace/feedback/evaluation experiment, then adopt/defer record; never replace durable task state | M8 |

### Repository execution and Git

The repository lease includes Intake's repository inspection, implementation,
review and candidate generation once a mutable branch context is acquired.
Other tickets queue instead of interleaving branches. Independent pure
requirements work may proceed without the lease; reading a changing checkout
requires the lease or a verified immutable snapshot. The lease is reconciled
after restart; an unresolved writer prevents new mutation-capable work.

Before branch preparation, validate canonical configured path, Git repository,
clean index/worktree, current HEAD, requested base ref, and branch ownership.
Use task-type/project naming policy and a collision-resistant ticket suffix;
Jira example feature/jira-123 is not a universal naming rule. Existing unrelated
branches/work are never overwritten. Deterministic Git service owns mutations;
agents return candidate changes/evidence. Cancel/stop preserve changes.

After a run settles, record candidate HEAD plus tracked/untracked delta manifest.
Dirty candidate ownership must be resolved before another ticket gets this
checkout. Commit/push authority is tied to the reviewed manifest and remote ref.
Never release repository ownership merely because a model returned text.

### Browser and integration authentication

M1 pairs the browser through a one-use random code displayed by the local server
or CLI. The code expires in 5 minutes, is stored hashed, is consumed atomically,
and is not the A2A bearer. Rate-limit failed exchanges. Pairing issues a random
HttpOnly, SameSite=Strict, host-only session cookie scoped to the dashboard API,
with 8-hour absolute expiry and explicit logout. Use Secure on HTTPS; beta
loopback HTTP is an explicit deployment limit. Pairing/session expiry does not
cancel a delivery run. Validate expected Host and Origin on pairing and mutations;
never enable unrestricted CORS. No credentials in bundles, query strings, traces,
or localStorage. Authenticate read API and file downloads as well as mutations.

Beta uses the single active installed Codex account; dashboard-managed multi-account
profiles and arbitrary provider endpoint overrides are deferred.
Codex OAuth remains in the installed CLI/App Server. UI shows account status and
setup instructions; it does not store ChatGPT access tokens or simulate OAuth.
Jira/Confluence read credentials use operator-configured server-side credential
references. For beta, configuration may reference environment/OS secret storage;
a general credential vault/admin editor is not required. Never ask users to put
credentials in ticket descriptions or uploaded files. Deployment-specific
connector authentication is validated during M6 before enabling retrieval.

### Attachments and limits

These are explicit beta engineering defaults, not claims about current support.

- At most 10 files per ticket, 10 MiB per file, 25 MiB combined; title 200 chars,
  description 32,000 chars, criteria 16,000 chars, 20 references per category.
- Store files under opaque server-generated artifact IDs outside the static UI
  directory. Validate size/type, reject path traversal, sanitize presentation,
  and serve through authenticated download endpoints.
- Initially extract UTF-8 .txt/.md/.json, bounded to 100,000 characters per file;
  images PNG/JPEG/WebP may be passed only through a verified model-input adapter.
- PDF/DOC/DOCX are reference-only downloads until an extractor is independently
  verified. Unsupported formats are rejected or explicitly reference-only;
  filename storage never implies the agent read the contents.
- Confluence/Jira retrieval has a 20-document, depth-2, 1-MiB-per-document budget;
  disclose truncation/inaccessible content. Allow only configured integration
  origins, not arbitrary operator-provided URL fetching by the server.

### Initial presets and beta Jira types

Jira types are source metadata, discovered/configured per deployment; do not
hardcode English type names or type IDs. PM classifies normalized work as feature,
bugfix, docs or audit, or records an unsupported/ambiguous classification. Beta
reads tasks/stories/bugs and their parent/epic where permissions allow. It creates
none of those records. Resolve unknown type mappings in project settings at M6.

Core versioned presets for M4:

| Preset | Required stages after Intake | Conditional involvement |
| --- | --- | --- |
| feature | Technical scope/design, Developer, Reviewer, QA, human review | Architect depth proportional to impact; Security/Performance/DevOps/Writer as scoped |
| bugfix | Reproduction/scope, Developer, Reviewer, QA, human review | Specialists based on cause and affected boundaries |
| docs | Technical Writer, independent review/validation, human review | QA verifies links/examples when relevant; Developer/Architect provide evidence |
| audit | Bounded investigation, independent synthesis/review, human review | Reviewer/Security/Performance/Architect according to audit purpose |

Intake precedes every preset. Selected required stages cannot be skipped by a
model's finish decision; optional stages and reasons are saved before dispatch.
Architect participation may be a light scoped technical plan rather than a full
design exercise. Other presets need separate validated definitions and pilots.

## Owned open decisions

| ID | Remaining choice | Owner | Must resolve by | Current boundary |
| --- | --- | --- | --- | --- |
| U-01 | Jira/Confluence deployment and read authentication method | Operator + integration lead | M6 connector setup | No credentials or live retrieval assumed |
| U-02 | Real Jira pilot issue keys and access-approved Confluence pages | Operator | M6 pilot | Local fixtures first; no fabricated issue keys |
| U-03 | Image/PDF/DOC extraction support | Implementation lead | M2/M6 format support | Explicit reference-only until verified |
| U-04 | Exact catalog/model/tier entitlement | Installed App Server + operator account | M5 | Capability-driven validation; no assumed access |
| U-05 | MLflow deployment/backend and adopt/defer result | Lead after experiment | M8 | Local telemetry is independent |
| U-06 | UX/UI design ownership for new products | Owner + lead | Post-beta product planning | Existing-ticket beta does not promise automated design |

No open item blocks M1. Jira write scope, repository serialization, entity
ownership, authentication strategy and PM coordination have explicit M0 decisions.
