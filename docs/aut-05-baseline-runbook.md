# AUT-05 runbook: regression corpus and baseline before AUT-01

Status: proposed execution instructions for an implementation agent.
Updated: 2026-10-15.

## 1. Mission and completion boundary

Implement the measurement foundation for AUT-05, capture a reproducible baseline,
and produce an independently reviewed `baseline_ready` handoff for AUT-01.

AUT-05 is the cross-cutting backlog item "Autonomy regression corpus and
measures" in `docs/orchestrator-improvement-backlog.md`. It starts before the
AUT-01 intervention and continues during later comparisons. `baseline_ready`
means the first preparation milestone passed; it does not mean all AUT-05 work
or the Spec Kit integration is complete.

Execution order:

```text
AUT-05 preparation
  -> accepted baseline_ready for a declared evaluation scope
  -> AUT-01 implementation and qualification
  -> AUT-05 comparison against the frozen baseline
  -> decision about retaining the change and planning the next intervention
```

The parent roadmap is [Spec Kit integration plan](spec-kit-luna-integration-plan.md).
This runbook defines its Phase 0. Later AUT-03/role/skill interventions need their
own frozen comparison baselines; they cannot reuse an incompatible AUT-01 result.

The task here is to implement and qualify the evaluation foundation. It does
not authorize launching or resuming an existing agent session, changing its
budget, installing another model/provider, or executing a paid benchmark.
Offline fixtures and existing reviewed exports are sufficient for the first
bounded scope. Record unavailable live measurements as unknown.

## 2. Required reading and actual source boundaries

Read the current teamwork handoff and Git status before editing. Preserve
unrelated changes and all owner pauses. Distinguish the harness from the target
orchestrator in evidence and identifiers.

Read these repository sources, in bounded sections:

| Source | What to establish |
|---|---|
| Backlog AUT-01 through AUT-05 and rollout policy | Intended constraints and evaluation requirements |
| `profiles/EVALUATION.md` | Whole-workflow evaluation and required success/failure cases |
| `src/contracts.js` and contract tests | Actual assignment, report, and boundary predicates |
| `src/review-policy.js`, relevant `src/lead-graph.js` sections and tests | Current-target review identity and gate rules |
| `src/usage-ledger.js`, `src/usage-report.js` | Available measured usage, missing data, attempt identity |
| `src/session-performance.js`, `src/performance-store.js` | Existing attempt projections and their limits |
| `src/staging-report.js`, `src/staging-log.js` | Historical problem/decision evidence and partial windows |
| `src/evidence-store.js` | Existing artifact retention, bounded payload handling, provenance |
| `docs/adr/staging-lessons-and-decision-log.md` | Durable evidence/status conventions |

Known source facts to preserve:

- `usage-report.js` reports subscription `measured.cost: null`. Its optional API
  pricing result is a hypothetical estimate, not measured subscription spend.
- A usage row, a task status, and a passing model sentence are not interchangeable
  with an accepted current-target checkpoint receipt.
- A repeated objective hash is not a reliable count of repair cycles.
- `performance-store.js` reads source state but writes a separate metrics DB and
  snapshot files. It is not a no-output export command; defaults can touch live
  project directories. Do not use its defaults for this milestone.
- `staging-report.js` exposes whether its retained event window is partial.
  An incomplete window cannot establish complete failure/escalation counts.
- Known producer/manifest/identity incidents also concern the separate target
  orchestrator. Do not invent a harness module that implements those checks.

## 3. Scope, owners, and implementation files

Use the existing Node/CommonJS toolchain and test runner. Begin with plain JSON
artifacts and a pure evaluator; a new database, daemon, UI, or model SDK is not
required for this milestone.

Proposed new files, refined only after inspecting current equivalents:

```text
docs/aut-05-baseline-runbook.md
docs/aut-05-metric-definitions.md
schemas/autonomy-corpus-v1.schema.json
schemas/autonomy-observation-v1.schema.json
schemas/autonomy-baseline-v1.schema.json
src/autonomy-evaluation.js
tools/autonomy/evaluate.js
test/autonomy-evaluation.test.js
test/autonomy-evaluation-cli.test.js
test/fixtures/autonomy/corpus-v1/
```

Keep the evaluator independent of `src/spec-analyzer.js` and future AUT-01
schemas. Baseline capture must work before AUT-01 exists.

- Lead owns scope, corpus selection, metric definitions, source/target identity,
  frozen baseline acceptance, and the final handoff.
- Engineer implements assigned evaluator/CLI/schema/fixture paths.
- Verifier inspects the integrated candidate and exercises the independent
  positive/negative cases through existing review contracts.
- Auditor reviews the retained evidence, metric semantics, and immutability
  claims under the existing policy for persisted formats and acceptance logic.

Keep overlapping module edits sequential. Each implementation dispatch has
bounded allowedFiles, source evidence, stop conditions, and a checkpoint. The
implementation agent does not accept its own baseline.

Tracked fixtures contain sanitized, minimal reproducible data. Generated run
exports belong under an explicitly assigned `artifacts/autonomy/<baselineId>/`;
`artifacts/` is currently ignored by Git. Retain an evidence manifest in the
existing durable evidence mechanism and record its storage location. Do not
force-add ignored state, DB files, credentials, or transient conversations.

## 4. Implement the contracts before the collector

### 4.1 Corpus manifest: `autonomy-corpus/v1`

Every case records:

- Stable `caseId`, revision, title, failure family, and evaluation mode.
- `targetSystem`: harness or target orchestrator, plus exact source snapshot.
- Goal, canonical input paths/digests, and all explicit constraints.
- Input and expected-outcome artifact paths/digests.
- An independently reviewed oracle: required observable outcome, forbidden
  effects, accepted evidence type, and the source contract defining that outcome.
- Applicability: which AUT intervention can affect this case, and which cases
  are regression controls rather than improvement targets.
- Adapter/assessment method, supported observations, and known limitations.

Supported modes:

1. `offline_contract`: execute existing local contract/review boundaries with
   fake transport and disposable state.
2. `artifact_assessment`: independently score a frozen planning artifact against
   a reviewed requirement/constraint inventory.
3. `historical_observation`: import an existing reviewed export with exact
   provenance; it is not a fresh execution.
4. `live_workflow`: reserved for separately authorized comparisons with an exact
   model/runtime/budget configuration and measured execution evidence.

Do not label a golden expected outcome as an observed baseline result. The
oracle says what should happen; the observation records what actually happened.

### 4.2 Observation: `autonomy-observation/v1`

Required identity and provenance:

- `observationId`, `caseId`, corpus revision/digest, and mode.
- `runId`, `taskId`, `assignmentId`, `attemptId`, checkpoint and candidate identity
  when the mode supplies them; otherwise explicit null plus reason.
- Target source snapshot and harness/runtime/configuration digests.
- Model ID/provider, reasoning settings, prompt/skill hashes, budgets, and tool
  configuration when applicable. Unknown fields stay unknown.
- Actual result, checks, acceptance disposition, forbidden-effect observations,
  and evidence artifact digests.
- Per-metric value, unit, availability, source reference, and missing-data reason.
- Evaluation time and the measurement interval, separated from deterministic
  content fingerprints.

Actual result is one of `pass`, `fail`, `inconclusive`, `not_supported`, or
`not_run`. The latter three must not increase a success numerator. Preserve
failures and incomplete attempts; do not retain only the final successful retry.

Reject duplicate observation/attempt IDs, cross-run joins, wrong corpus digests,
unsupported schema versions, coercions, and contradictory nested identity fields.
A numeric zero is valid only when directly observed; absence is null.

### 4.3 Baseline manifest: `autonomy-baseline/v1`

Record:

- Unique `baselineId`, corpus digest, target/source snapshot, and evaluator version.
- Exact metric-definition version and predeclared hard acceptance rules.
- Ordered case-to-observation references, source/output digests, and limitations.
- An explicit supported scope, such as `offline_contract_and_artifact`.
- Snapshot completeness and per-metric availability coverage.
- Independent verification/audit evidence references.
- Lifecycle status: `draft`, `captured`, `verified`, `baseline_ready`, or
  `superseded`. A failed validation is a finding, not a promoted status.

Only the lead records the accepted `baseline_ready` reference after existing
review requirements are satisfied. The evaluator emits findings and eligibility;
it does not grant project acceptance or clear a runtime gate.

Baseline artifacts are immutable after capture. Changed corpus, metric
semantics, source/configuration, or oracle creates a new baseline revision and
explicit comparison eligibility assessment. Do not overwrite old results.

## 5. Define metrics and denominators explicitly

Implement these definitions in `docs/aut-05-metric-definitions.md` before
calculating them. Every reported ratio includes numerator, denominator, excluded
incomplete count, observation mode, and provenance.

| Metric | Definition and boundary |
|---|---|
| Requirement/constraint preservation | Reviewed required IDs satisfied by the observed artifact divided by all mandatory IDs; list every missing/violated ID |
| First-pass accepted checkpoints | Checkpoints whose first candidate obtained the complete required current-target review sequence without repair, divided by checkpoints with a fully observed first-review outcome |
| Accepted results | Results with all required deterministic checks and matching current-target acceptance evidence; completed task status alone is insufficient |
| Repair cycles | Distinct observed failed-review-to-candidate-repair sequences; report underlying assignment/candidate IDs, not objective hashes or raw round numbers |
| Review cycles | Distinct observed candidate/checkpoint review sequences; keep verifier/auditor steps and retry attempts separately visible |
| Owner escalations | Unique durable owner-input decisions; deduplicate retries/polls, retain the reason and decision ID |
| Elapsed time | Wall time from declared cohort/case start to terminal result; report pause handling and incomplete intervals |
| Tokens | Observed input/cached/output/total fields with source coverage; never add cached input to input again |
| Measured cost per accepted result | Total measured cohort cost, including failed attempts, divided by accepted results; require complete compatible cost coverage and nonzero denominator |

If input and output counts allow a derived token total, label it as derived and
record the formula. An attempt-time sum is not wall-clock elapsed time for
parallel work. Permission denials are not owner escalations unless an actual
owner decision was requested.

For first-pass metrics, define the cohort before scoring and list checkpoints
with missing first-attempt evidence. Do not improve the ratio by omitting hard
cases. With no eligible observations, return null and an explicit reason.

For this milestone, subscription monetary cost remains null unless another
actual measured-spend source is supplied and validated. Hypothetical API prices
may be shown in a separate field with their own pricing version; they cannot
fill measured cost or justify a savings claim.

## 6. Build the first corpus

Include the four failure families named in AUT-05 and positive controls:

| Case | Required evidence boundary |
|---|---|
| Canonical identity incomplete or contradictory | Reject/refrain from authorizing when the actual target contract requires missing identity fields |
| Nested manifests contradict each other | Retain disagreement and the contract's failure outcome; equality of one projection is insufficient |
| Fixture/dispatcher producer mismatch | Preserve required producer provenance; test both expected producer and a lookalike/wrong producer |
| Stale review continuation | Observe rejection before model execution and distinguish a later fresh review from replay of the stale origin |
| Valid ordinary result | Preserve a positive control with a complete accepted evidence sequence |
| Failed/incomplete result with missing usage | Keep failure and unknown metrics; never fabricate acceptance or zero spend |
| AUT-01 planning baseline | Freeze one representative feature's canonical inputs and tasks produced by the current workflow before the new checker or decomposition skill |

For the target-orchestrator cases, locate the accepted incident/source evidence
from existing handoffs and project docs. Use bounded read-only inspection of an
available frozen source/export; no live A2A task is resumed or mutated. Each
case must identify its actual target implementation or recorded execution.
If evidence is unavailable, report that limitation and resolve the missing case
before claiming complete corpus coverage; do not substitute an invented harness
predicate or a tautological JSON expectation.

A historical observation can establish corpus provenance and expected failure
shape. Only an executable adapter against a pinned target establishes fresh
runtime behavior. Keep those scopes separate in baseline readiness and reports.

For the AUT-01 planning case, freeze canonical inputs, the reviewed mandatory
inventory, current-workflow planning output, and an independent assessment of
that output. This can be an explicitly reviewer-scored artifact baseline with
unknown token/cost/timing metrics. It must not depend on the future analyzer.
Do not pre-correct its omissions before recording the baseline.

Each negative case has a positive control proving the adapter is not simply
returning failure for every input. Expected results come from the source
contract or accepted requirement, not from the evaluator's output.

## 7. Capture and retain a consistent baseline

### 7.1 Prepare the snapshot

1. Record actual Git HEAD, dirty-file inventory, and raw-byte hashes of relevant
   source, role, prompt, contract, and fixture files. HEAD alone is insufficient.
2. Freeze the corpus/oracle/metric definitions before recording observations.
3. Use disposable workspaces and frozen DB/export inputs. For SQLite, obtain a
   consistent backup/export; copying only a live main DB file can omit WAL data.
4. Record source/target identity and the declared evaluation mode for every case.
5. Keep implementation of this evaluator separate from the behavior being
   measured. Do not install AUT-01 or change roles/prompts before the AUT-01
   planning baseline has been captured.

No existing service lifecycle action is necessary. If a required input cannot be
obtained consistently under existing access, continue independent corpus work
and return a specific missing-evidence finding; do not stop a live project to
create the snapshot.

### 7.2 Reuse existing read-only reports where applicable

These commands already exist. Apply them only to explicitly selected frozen
snapshot files, with real IDs from the manifest:

```text
npm run usage -- --state <frozen-state.sqlite> --run <runId>
npm run staging:report -- --state <frozen-state.sqlite> --run <runId> --json
```

The usage report is already JSON; it has no `--json` flag. Retain its raw result
and the source snapshot digest. Inspect staging coverage and missing-table
status rather than interpreting an empty window as zero historical problems.
Neither report alone proves first-pass accepted checkpoints or full chronology;
join the actual journal/review records only when the identity chain is complete.

Do not silently fall back to the default state path. The new evaluator takes
explicit input paths and validates all joins before summarizing metrics.

### 7.3 Proposed offline evaluator interface

Implement an interface equivalent to:

```text
node tools/autonomy/evaluate.js \
  --corpus <corpus-manifest.json> \
  --observations <observation-manifest.json> \
  --baseline <baseline-manifest.json> \
  --json
```

This new command does not exist yet. It reads frozen inputs, validates contracts,
computes supported metrics, and emits findings plus a summary to stdout.
It never invokes a model, runs arbitrary corpus shell commands, edits source
state, or writes its own acceptance status into a database.

Use fixed, reviewed local adapters for optional executable fixture collection;
commands supplied by observation JSON remain data. Any collection output has a
caller-owned explicit destination under the isolated artifacts directory.
Separate collection from evaluation so replay does not mutate frozen evidence.

Exit 0 means the supplied observation set is structurally valid and fully
assessed for its declared scope, not that every target case passed. The report
contains the actual pass/fail counts and readiness limitations. Use nonzero
codes for invalid inputs, incomplete required evidence, or evaluator failure.
Keep process success separate from target outcome and project acceptance.

## 8. Implementation sequence

| Step | Action | Acceptance before advancing |
|---|---|---|
| B0 | Inventory actual sources, incidents, available exports, and current planning workflow | No guessed data source; exact mode/target for each case |
| B1 | Define corpus, observation, baseline schemas and metric definitions | Stable IDs, strict types, provenance, null handling, denominators, independent oracle |
| B2 | Prepare sanitized cases and freeze an AUT-01 planning baseline | All required families represented; baseline output predates AUT-01 intervention |
| B3 | Implement pure evaluator and explicit-input CLI | No model execution; stable deterministic content summary; all source joins validated |
| B4 | Collect observations through reviewed adapters/exports and capture baseline | Raw evidence retained, missing metrics explicit, no source state mutation |
| B5 | Verify and audit integrated evaluator/evidence | Positive/negative cases pass; actual baseline limitations accepted |
| B6 | Lead records `baseline_ready` and hands off AUT-01 | Handoff states supported comparison scope and exact immutable artifact references |

Use existing independent verifier and auditor roles. An external coding agent
can implement the same bounded steps, but cannot promote its own evidence to
accepted baseline status. Do not infer execution authority from the model name.

## 9. Required verification for the implementation agent

These are implementation acceptance obligations; no tests have been run merely
by authoring this runbook.

- Complete known metrics aggregate correctly; missing values remain null with
  coverage. Partial cost cannot become a complete cost-per-result metric.
- Failed attempts remain in cohort costs and repair history. Duplicate
  observation/attempt IDs do not inflate either numerator or denominator.
- Contradictory source/run/task/attempt/candidate identities are rejected.
- Stale or wrong-target receipts do not become accepted results, even if a
  worker report or display projection says passed.
- A valid frozen artifact and an intentionally defective one receive different
  independent oracle outcomes; an expected golden result is not an observation.
- One cohort with no eligible denominator returns null, not zero/infinity.
- Partial staging history and missing usage tables are reported as incomplete.
- Subscription cost and hypothetical API estimates remain distinct.
- Replaying the same inputs produces the same content fingerprint and metric
  values. Collection timestamps remain separate metadata.
- Corpus, metric, model/configuration, or acceptance-rule mismatch makes a
  comparison ineligible; no silent cross-version merge.
- Source snapshots, the fixture workspace, and readonly DB inputs remain
  unchanged; a sentinel corpus command is not executed by evaluation.
- Invalid JSON, unexpected fields, wrong types, missing required artifacts, and
  corrupted digests produce bounded diagnostic failures.

Run focused new evaluator/CLI tests, then existing project checks at milestone
integration under normal project permissions. Record commands, source versions,
outcomes, and any unrelated baseline failures. Never weaken expected outcomes
to make the current target appear healthier.

## 10. Readiness decision and AUT-01 handoff

The lead can record `baseline_ready` for `offline_contract_and_artifact` only when:

1. The versioned corpus includes all four named incident families, controls, and
   the frozen representative AUT-01 planning artifact with independent oracle.
2. Every case has a validated observed result or a clearly declared historical
   observation with accepted provenance. Required missing cases remain blockers.
3. Source versions, acceptance rules, metric definitions, configuration, and
   comparison scope are frozen with exact artifact digests.
4. All available measurements are retained and unavailable metrics have explicit
   reasons. Unknown live cost/time is not itself a blocker for this offline scope.
5. Evaluator implementation and baseline interpretation have independent
   verifier/auditor evidence covering the integrated candidate.
6. The durable handoff includes an exact location for ignored generated evidence
   and does not rely only on a temporary `/tmp` path.

Do not call this a qualified live-model benchmark. A later claim about token,
cost, latency, first-pass acceptance, or model superiority requires compatible
paired observations with complete data for the particular metric.

The AUT-01 handoff contains:

```text
baselineId and baseline manifest digest
accepted scope and explicit limitations
corpus and metric-definition digests
canonical feature input and baseline planning-output digests
source/configuration versions and dirty-file hashes
per-case observations and independent oracle references
verification and auditor evidence references
generated evidence storage location
next AUT-01 work item and paths
```

The next work item is parent-plan P1.0-P1.1. Reuse the frozen feature inputs and
accepted scope; do not replace a difficult baseline feature with an easier one
without creating a new comparison cohort. Adapt the AUT-01 technical plan only
where baseline evidence exposes a concrete need.

After AUT-01, run the same applicable cases and retain both old and new outputs.
Report capability changes, regression controls, unknown measurements, and any
comparison exclusion explicitly. AUT-05 continues with each later intervention.

## 11. Brief for an external coding agent, including DeepSeek

Use this runbook as the task brief with the current project instructions and
explicit assigned files. Begin with B0-B1 and report the source map, schemas,
metric definitions, intended adapters, and blockers before implementing B2-B4.
This is a bounded checkpoint for review, not a new user permission requirement.

Required result format for each checkpoint:

- Completed work and changed files.
- Exact source/evidence identities and decisions made within assigned scope.
- Verification commands and actual results.
- Unavailable measurements, unresolved questions, and next bounded action.

The first assignment should cover schema/metric definitions and a small
complete fixture. Expand only after review confirms correct null semantics,
identity joins, denominator rules, and oracle independence. Preserve accepted
baseline bytes and all existing review/authority boundaries.

An external DeepSeek-based coding agent is an implementation worker for this
brief. Start with B0-B1, inspect the actual result, and expand its assignment only
after review. Qualify its work by observable artifacts and checks; this runbook
does not assume a particular model version has already passed this workload.
Keep independent verification and final baseline acceptance with the lead and
review roles established for the project.
