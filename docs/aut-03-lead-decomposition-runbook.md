# AUT-03 runbook: lead-only spec decomposition skill

Status: AUT-02 entry condition verified and accepted; AUT-03 offline lead-skill
delivery and plumbing are independently verified. Paired trial and effectiveness
remain pending separate authorization. The independent runbook review is
[approved](evidence/aut-03/runbook-review.md).

## 1. Mission and boundary

Evaluate one optional, versioned and hash-pinned skill that helps the lead turn
a short goal and accepted canonical context into an ordered roadmap, a complete
requirement-to-task map, and a dispatch-readiness report. The skill should help
the lead preserve explicit constraints, expose missing decisions, identify
dependency and scope defects, and produce proposals that pass the existing
AUT-01 analyzer and assignment contracts.

This is a lead instruction intervention. It does not create worker procedures,
new roles, a global system-prompt expansion, a dispatch gate, feature enrollment,
or mutation authority. The skill cannot accept its own map, rewrite canonical
documents, select user-owned decisions, authorize a writer, or replace verifier,
auditor, budget, pause, or acceptance gates.

This runbook prepares implementation and evaluation. It does not authorize live
model calls or a running-service update. Fake App Server tests can qualify the
delivery path; they cannot establish planning quality or savings. Any later live
comparison must use an explicitly authorized bounded trial and retain actual
usage evidence. Without it, report model-quality and cost outcomes as unavailable.

## 2. Entry checkpoint S0

1. Read `.agents/teamwork/PROJECT.md`, current handoffs, Git status/diff, this
   runbook, backlog AUT-03, parent plan section 13.2, and the completed AUT-02
   decision when available. Preserve unrelated changes and existing pauses.
2. Verify `docs/evidence/aut-05/acceptance.json` and
   `docs/evidence/aut-01/acceptance.json`, then rehash their referenced evidence.
   Verify AUT-02's accepted decision and current source/test hashes before
   starting. A runbook or partial review is not milestone acceptance.
3. Reuse the accepted AUT-01 pilot context and F2 repair case as the structural
   anchor. Its context digest is
   `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf` and its
   map digest is
   `212f256587a672c4c6de818a67a52e8a0463663258f39756d9409a6e53be3ec8`.
   Recheck these values against the accepted manifest; do not trust this copy if
   it differs.
4. The AUT-05 v3 planning artifact is a manually authored lead artifact, not a
   live-model workflow baseline. Preserve it as historical evidence; do not use
   it to claim model improvement. Freeze a new no-skill lead baseline on the
   trial cases before attaching the skill.
5. Before baseline capture, declare the case set, canonical input hashes,
   expected requirements and constraints, missing-decision oracle, model and
   effort, prompt/runtime versions, tool policy, budgets, run count, scoring
   rubric, and retention thresholds. Store the declaration in
   `docs/evidence/aut-03/entry.json`. A change after capture starts a new cohort.

Entry fails on an unaccepted AUT-02 implementation, changed or unavailable
canonical inputs, missing expected context digest, unpinned runtime/model
configuration, or an undeclared comparison threshold. Do not silently replace
the AUT-05 baseline or AUT-01 artifact bytes.

## 3. Existing delivery path and design constraint

Recheck these paths at implementation entry because source lines can move:

- `src/lead-graph.js`: `fullPrompt`, `deltaPrompt`, and `runLead` build each
  coordinator turn. The lead sees compact skill IDs and descriptions for
  selecting skills on worker assignments.
- `src/skill-catalog.js`: the current catalog and pin resolver serve ordinary
  per-assignment `skills`.
- `src/a2a-role-service.js`: the specialist boundary validates assignment skill
  IDs and pins.
- `src/codex-app-server.js`: `run({ selectedSkills })` validates pinned skill
  files and sends explicit skill inputs on `turn/start`.
- `src/role-catalog.js`: the lead is read-only and its current tool policy has
  skills disabled. Keep that policy and its other tools unchanged.
- `docs/skill-routing.md`: current catalog/import scope and per-worker limits.

Current `assignment.skills` delivery targets the worker for that assignment;
it does not prove a lead-only skill reaches the coordinator. Merely creating a
skill file, loading it in a catalog, adding its name to a prompt, or seeing it in
`profiles/skills/library` does not qualify AUT-03.

At S1 choose and record the smallest trusted lead-only delivery path. A candidate
is a runtime-owned skill pin supplied to the coordinator `turn/start` call via
the existing explicit skill-input mechanism, with its hash verified before each
turn. It must remain unavailable to ordinary worker selection. Inspect how this
interacts with the lead's disabled skill tools; explicit instruction injection
must not turn on bundled skills, MCP, plugins, apps, or other tools. Do not take
the skill ID, path, or hash from the lead's proposed JSON.

Pin the selected skill ID and SHA-256 in run/session evidence. Deliver it on
every applicable full, delta, and resumed coordinator turn, including after
thread rollover. A changed or unavailable pin must stop or start a fresh
full-context lead thread under the declared policy; do not mix old-thread skill
instructions with a new version. Ordinary runs have the skill off by default.
The AUT-03 trial opt-in applies only to the lead and the named trial runs.

## 4. Skill input and output contract

The lead consumes:

- The owner's goal and constraints, clearly marked authoritative.
- Accepted, hashed canonical documents and their requirement/acceptance IDs.
- A reviewed, immutable AUT-01 feature context containing source inventory,
  scope, risk rules, evidence catalog, and expected context digest.
- The current runtime's actual role and assignment contract, checks, review
  rules, and remaining round/token budgets.

The skill produces proposals only:

1. A concise roadmap with ordered phases, prerequisite decisions, and stop
   conditions.
2. A machine-readable task map using the accepted AUT-01 schema and context
   digest. Every task links to requirement/acceptance IDs, dependencies, write
   paths, checks, evidence, review context, and stop conditions. Every required
   implementation or review proposal is compiled through the existing adapter.
3. A readiness report that distinguishes structural findings from questions
   requiring the owner. It records `ready`, `review`, or `blocked` and cites
   the analyzer fingerprint and exact input references.

Use the existing AUT-01 CLI and contracts to validate the map and every proposed
assignment. The analyzer's expected context digest comes from the reviewed
manifest, never the proposed map. A passing analyzer report establishes only
structural readiness under its documented assumptions. It does not prove prose
semantics, execute checks, accept implementation, or authorize dispatch.

If a canonical requirement is missing, sources conflict, scope cannot be
bounded, a decision belongs to the owner, or a check/evidence source is absent,
the skill reports the specific gap and blocks the affected tasks. It must not
invent a decision, requirement, approval, file path, check result, or evidence.
The lead resolves findings explicitly. Canonical files remain unchanged during
planning and analysis.

## 5. Trial design and frozen baseline

Create an isolated cohort under `test/fixtures/autonomy/aut-03/`; retain reviewed
decisions and results under `docs/evidence/aut-03/`; generated outputs belong in
`artifacts/autonomy/aut-03/`. These are proposed destinations, not existing
acceptance evidence.

Use a predeclared set that includes the accepted F2 `pilot-price` anchor and
representative bounded planning cases with multiple requirements, dependencies,
scope limits, checks, and evidence. Include at least one case with an unresolved
owner decision and one contradictory or incomplete source control whose correct
result is a blocker. Seed source defects in isolated copies only. Have an
independent reviewer pin the oracle and expected safe outcome before capturing
either condition. Keep AUT-05 historical target incidents as regression controls;
do not score them as new AUT-03 observations without a suitable canonical
planning input and oracle.

For each case, capture paired no-skill and skill-enabled runs with:

- Identical canonical input bytes, accepted context digest, feature/checkpoint,
  goal, runtime and contract versions, role profile, model, reasoning effort,
  tools, context window, timeout, round/token budget, and acceptance rules.
- A fresh isolated lead thread and state for each run. Do not let a prior trial
  output or the AUT-01 map enter only one condition.
- A predeclared number and order of repetitions. Record model nondeterminism and
  keep every attempt, including blocked, invalid, and incomplete outputs.
- The exact prompt/skill hashes, generated artifacts, analyzer fingerprint,
  candidate assignments, review context, token usage, elapsed time, and measured
  cost when the runtime provides them.

The no-skill condition is captured first and frozen. The accepted manual AUT-05
artifact is not a substitute for this live paired baseline. If live model calls
are unavailable or not authorized, complete delivery/plumbing tests only and
leave quality and economy acceptance pending.

## 6. Qualification matrix

Retain named tests, hashes, prompt/turn-start evidence, maps, analyzer reports,
oracle assessments, and actual outcomes for each case.

| ID | Probe | Required result |
| --- | --- | --- |
| S01 | Effective skill pin | The trusted runtime supplies exactly the declared skill and hash to the lead; hash drift, missing file, or wrong identity blocks before a lead model turn. |
| S02 | Lead-only boundary | The skill is absent from ordinary worker candidates and worker turn/start inputs; ordinary worker `assignment.skills` behavior remains unchanged. |
| S03 | Prompt lifecycle | Full, delta, resumed, rolled-over and rejection-retry lead turns receive the same selected pin; changed pins cannot reuse a thread with stale instructions. |
| S04 | Scope and authority | Preserve every explicit user constraint and accepted context boundary; do not alter canonical files, grant scope, or claim approval. |
| S05 | Missing decisions | Identify each oracle-listed owner decision and block affected tasks without guessing an answer. |
| S06 | Requirement coverage | Trace every mandatory requirement and acceptance criterion; expose uncovered and orphaned work. |
| S07 | Dependency correctness | Produce a valid DAG and correct prerequisite order; reject or report seeded cycles, dangling edges, and unsafe parallelism. |
| S08 | Dispatch readiness | Every proposed task and review passes the real adapter and assignment contracts, or the report blocks with a concrete reason. No sampling. |
| S09 | Analyzer boundary | Use the frozen expected context digest; seeded context/map drift and scope defects are detected; files remain byte-identical. |
| S10 | Negative and ordinary controls | Contradictory source blocks; a no-skill unrelated ordinary run keeps current behavior and receives no lead skill. |
| S11 | Acceptance preservation | Existing verifier/auditor order, checkpoint context, owner pause, budget, writer and final acceptance gates remain intact. |
| S12 | Measurement integrity | Paired runs use identical declared conditions; missing usage stays unavailable and fake tests are not reported as quality gains. |

The delivery tests use a fake Codex App Server protocol and inspect the actual
coordinator `turn/start` payload. Confirm that one skill input reaches only the
lead and that tool policy remains unchanged. A catalog-load assertion or a
prompt string containing the skill name is insufficient. Exercise stale pin and
thread-resume behavior. The planning trials use independent scoring against the
frozen oracle; do not let the skill grade its own outputs.

## 7. Measures and retention decision

Score each condition on the same cases and rubric:

- Explicit constraint preservation, with zero loss as a hard requirement.
- Owner-decision detection and invented-decision count, with zero invented
  decisions as a hard requirement.
- Mandatory requirement and acceptance coverage, task-to-requirement trace,
  dependency correctness, scope correctness, and stop-condition coverage.
- Valid assignment/review proposals and analyzer outcome, with no invalid
  proposal counted as ready.
- First-pass structurally ready maps, repair/review rounds, blocked-task recall,
  and owner escalations.
- Lead prompt/input tokens, total measured tokens, elapsed end-to-end time, and
  measured cost per accepted planning result. Keep unavailable values null with
  an explicit reason.

Before baseline capture, set the minimum quality effect needed to retain the
skill and maximum acceptable prompt/token, latency, and cost growth for this
trial. A reviewer checks these thresholds against the task budget. Do not choose
thresholds after seeing outcomes. Retain the skill only when mandatory safety
and correctness gates pass and the predeclared quality/efficiency decision is
met. More tokens alone do not demonstrate value; fewer tokens never compensate
for a lost constraint, invented decision, invalid task, or bypassed gate.

Report aggregate and per-case results. Separate deterministic delivery
qualification from model-output quality. The F2 semantic baseline already had
5/5 preservation; do not claim a semantic improvement from merely adding IDs or
passing the structural analyzer. A small pilot supports a bounded retention
decision, not broad superiority or production savings.

## 8. Work packages and verification

The lead owns scope, baseline/evidence, runtime decisions, Git, and final
acceptance. Sequence shared runtime edits.

| Package | Owner | Exit evidence |
| --- | --- | --- |
| S0 | Lead | Accepted AUT-02 decision, exact AUT-01 context, frozen case set, model/tool/budget and oracle declaration |
| S1 | Explorer if needed, then lead | Actual lead `turn/start` path and session/hash lifecycle traced; chosen isolated delivery design reviewed before implementation |
| S2 | Worker | One versioned skill file with bounded purpose, no bundled scripts/references unless separately hashed; strict lead-only opt-in and pin config |
| S3 | Worker | Lead-only selection/injection across full/delta/resume, unchanged tool policy and worker skill behavior, focused boundary tests |
| S4 | Worker and independent scorer | Frozen paired trials, AUT-01 analysis, adapter checks, per-case oracle scores, actual usage or explicit unavailable values |
| S5 | Verifier then auditor | Final source, skill, fixtures, prompts, metrics and evidence bound to exact hashes; all hard gates pass |
| S6 | Lead | Comparison, retention/defer decision, backlog status and next handoff |

Likely implementation files include `src/lead-graph.js`, the trusted skill
loader/configuration, and tests for the App Server `turn/start` contract and
lead prompt lifecycle. Assign exact files after S1. Do not modify
`assignment.skills` to masquerade as lead delivery. Do not change worker roles,
global skills, MCP policy, required reviews, or the analyzer's trust boundary.

Run focused tests for each changed contract. At milestone integration run the
existing project suite and the exact AUT-01 analyzer/adapter qualification
commands retained in `docs/evidence/aut-01/verification-results.json`. Reuse
unchanged AUT-01/AUT-02 results where their input hashes remain valid; rerun
affected checks after changes. Retain exact commands, leaf counts and skips.
No live application or deployment is part of these checks.

## 9. Acceptance and next handoff

Accept AUT-03 only when S01-S12 have outcomes, paired no-skill/skill trials are
bound to the same declared conditions, independent scoring passes, all mandatory
constraints and existing gates hold, verifier and auditor approve the final
hashes, and the predeclared retention rule is applied. Otherwise record the
bounded delivery capability, unresolved measurement, and retain/defer decision
without calling the skill effective.

Retain `entry.json`, case/oracle manifests, source/skill/prompt hashes,
turn-start evidence, maps, reports, test results, per-case scoring, metric
availability, comparison, reviews, and `acceptance.json` under
`docs/evidence/aut-03/`. Link the exact decision in the backlog and roadmap.
The skill remains opt-in for the named lead trial unless an accepted later
decision expands that scope.

Rollback disables lead-skill selection, preserves trial evidence, and starts a
new lead thread without stale skill context when a run must continue. Keep
ordinary worker skill routing and tool permissions on their existing contracts.
Any live service/session application requires its own lifecycle authorization.

Implementation handoff: start at S0 after AUT-02 acceptance, freeze paired
no-skill outputs, resolve S1 delivery design, then proceed through S2-S6. Record
verified facts, hashes, exact checks, results, limitations, and next action in
the local teamwork handoff. AUT-04 tools remain conditional on measured retrieval
failures; they are not a dependency of this skill trial.
