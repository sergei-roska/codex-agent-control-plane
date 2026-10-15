# Spec Kit integration plan for the harness

Status: proposed implementation plan. Phase 0 is the next bounded milestone.
Updated: 2026-10-15.

## 1. Decision and intended result

Use the local Spec Kit repository as a source of workflow procedures and artifact
conventions. First establish the AUT-05 regression corpus, metric definitions,
and frozen baseline using [the AUT-05 runbook](aut-05-baseline-runbook.md). Then
start the artifact pilot required by AUT-01. Qualify its data model before adding
roles, installing skills, or changing dispatch behavior.

The first AUT-01 deliverable is a deterministic, read-only planning checker. Given a
reviewed feature context, canonical documents, and a derived task map, it must:

1. Account for every mandatory requirement and acceptance criterion in scope.
2. Reject unknown references, orphan tasks, cycles, and incompatible parallelism.
3. Compare requested writes with independently established feature boundaries.
4. Detect missing prior evidence and missing planned acceptance checks.
5. Compile every implementation task into a complete harness assignment.
6. Validate those assignments through the existing exported contract functions.
7. Produce a reproducible report bound to its exact inputs and checker version.

A passing report establishes structural planning readiness under stated offline
assumptions. It does not accept an implementation, prove arbitrary prose
consistent, or grant permission to dispatch a writer.

After Phase 1 evidence is accepted, subsequent milestones may add an opt-in
runtime gate and the adapted Spec Kit workflow under the existing lead. The
existing engineer and verifier use gpt-6-luna; the existing auditor supplies the
independent reviews required by harness policy. New role profiles are conditional
on a demonstrated need for separate instructions or permissions.

## 2. Grounding, terminology, and boundaries

### 2.1 Sources inspected

This plan was grounded in the current working tree, including its uncommitted
changes. Baseline commit identifiers are references, not claims that the working
tree equals those commits:

- Harness: `/home/sr/Projects/Workspace/codex-agent-control-plane`, HEAD
  `d71183a458ab2a9ee04dcfa68a2f32b0e336d3a7`.
- Spec Kit: `/home/sr/Projects/Workspace/spec-kit`, HEAD
  `3238fa9285694dc539aeb9829b337bfd6aed7317`.

Recheck relevant source bytes when implementation starts. Record changed-file
hashes alongside the commit identifiers in pilot evidence.

| Source | Contract reused |
|---|---|
| `docs/orchestrator-improvement-backlog.md`, AUT-01 | Stable requirement/acceptance IDs, bounded tasks, dependencies, paths, checks, evidence, reviews, stop conditions |
| Same backlog, AUT-02 | Fresh reviews of changed candidates; stale continuations remain nonauthorizing |
| Same backlog, AUT-03 | One optional pinned decomposition skill delivered to the lead |
| Same backlog, AUT-04/AUT-05 | Conditional evidence tools; baseline and outcome measurements |
| `src/contracts.js` | `validateDecision`, `checkSpecialistRequest`, `checkReviewContext`, path rules, size limits |
| `src/lead-graph.js` | Actual review obligations, candidate identity, verifier/auditor ordering, writer admission |
| `src/role-catalog.js` and `profiles/TEAM.md` | Effective roles, sandbox settings, review policy |
| `src/skill-catalog.js` | Catalog metadata, selected-skill hashing, maximum five skills per assignment |
| Spec Kit `templates/commands/*.md` | Procedures and side effects that require adaptation |
| Spec Kit `templates/{spec,plan,tasks}-template.md` | Human-readable artifact conventions |
| Spec Kit `scripts/bash/common.sh`, `setup-plan.sh`, `setup-tasks.sh` | Feature resolution and setup semantics |
| Spec Kit `README.md` and `templates/commands/converge.md` | Repeated implementation and convergence; exact outcomes |

The local Spec Kit source is the integration reference. Its CLI and scripts are
not runtime dependencies of Phase 1. Later adaptations record the upstream
revision and source file hashes; harness skill pins identify the adapted bytes.

### 2.2 Terms

- Harness: this repository and the agent system it runs.
- Lead: the harness role that owns planning, scope decisions, and acceptance.
- Orchestrator: the separate system being developed using the harness.
- Canonical sources: the existing PRD, accepted plans, and explicit project
  decisions. They remain the sources of intended behavior.
- Feature context: a reviewed, versioned projection of those sources and the
  feature's scope, checks, evidence references, and risk rules.
- Task map: a derived implementation proposal checked against that context.
- Analysis report: evidence about a particular context/map/source snapshot.
- Review receipt: existing harness evidence about an actual candidate. An
  analysis report is not a review receipt.

### 2.3 Phase boundaries

| Milestone | Included | Exit result |
|---|---|---|
| Phase 0: AUT-05 preparation | Regression corpus, metric definitions, independent oracle, frozen current-workflow baseline | Accepted `baseline_ready` for a declared comparison scope |
| Phase 1: AUT-01 artifact pilot | Context and map contracts, checker, assignment adapter, fixtures, offline qualification | Every derived task is structurally valid; all required defect classes are detected |
| Phase 2A: optional dispatch integration | Trusted feature enrollment, freshness binding, admission checks, persistence/recovery | Qualified enforcement on explicitly documented entrypoints |
| Phase 2B: Spec Kit worker workflow | Adapted procedures/skills, feature setup, implementation/convergence loop | One bounded feature completes with existing acceptance gates |
| Phase 3: evaluated autonomy improvements | AUT-02 regression, one lead skill for AUT-03, conditional AUT-04 tools | Comparison through the ongoing AUT-05 process with unchanged acceptance rules |

AUT-05 spans all phases. Phase 0 establishes the initial measurement foundation;
it does not complete the cross-cutting evaluation item. Later interventions
freeze compatible comparison cohorts before making retention or savings claims.

Phase 1 adds no new roles, installed skills, live model calls, server restarts,
SQLite migrations, or dispatch hooks. It does add standalone source modules and
an offline CLI. The later phases are design directions with entry criteria;
their implementation starts only after the preceding evidence is assessed.

## 3. Phase 1 architecture and authority

Entry condition: an independently reviewed `baseline_ready` handoff from the
AUT-05 runbook. Reuse its representative feature, canonical inputs, baseline
planning artifact, metric definitions, and declared comparison limitations.
Unknown live-model measurements do not prevent an explicitly offline pilot;
they prevent unsupported claims about live-model improvement or savings.

### 3.1 Separate the approved context from the proposed map

Use two distinct input documents:

1. `pilot-context.json`: the feature boundaries and complete in-scope source
   inventory, prepared by the lead from canonical documents and inspected through
   the existing review process.
2. `traceability.json`: the task proposal, which references that context and
   cannot change its boundaries, source inventory, evidence catalog, or risk rules.

The offline invocation supplies the context path and its expected SHA-256 from
the reviewed pilot baseline. Do not obtain that expected digest from the task map.
The analyzer checks the context bytes against the supplied digest before using
any of its permissions or inventories.

For the controlled fixture, the expected context digest is held in its reviewed
fixture manifest. For an eventual project pilot, the lead retains the accepted
baseline reference outside the task author's write scope. This uses normal
project scope/review authority; it introduces no new user approval ritual.

A worker cannot expand its scope by editing both JSON files and reporting that
they agree. A changed context requires a new baseline assessment and invalidates
all reports made against the previous context.

### 3.2 Establishing the source inventory

The lead identifies all mandatory requirements and acceptance criteria for the
bounded feature, with stable IDs and exact source locations. Reuse existing IDs.
Where a canonical document lacks IDs, assign stable projection IDs associated
with source locations; do not rewrite the canonical document just to run the pilot.

An independent reviewer checks inventory completeness, the interpretation of
source clauses, scope, risk labels, and unresolved decisions before the baseline
is retained. This semantic check is required because a deterministic program
cannot discover every requirement omitted from arbitrary prose.

The checker subsequently proves coverage of that accepted inventory. It must
never claim that a self-authored inventory proves its own completeness.

Use one representative feature with at least two mandatory requirements,
acceptance criteria, a dependency chain, two potentially parallel tasks, an
explicitly forbidden path, and one risk-sensitive requirement. Include an
ordinary task as a control against classifying everything as critical.

### 3.3 Proposed files

```text
docs/spec-kit-luna-integration-plan.md
schemas/spec-context-v1.schema.json
schemas/spec-traceability-v1.schema.json
src/spec-context.js
src/spec-analyzer.js
src/spec-assignment-adapter.js
tools/spec-kit/analyze.js
test/spec-context.test.js
test/spec-analyzer.test.js
test/spec-assignment-adapter.test.js
test/spec-analyzer-cli.test.js
test/fixtures/spec-kit/pilot-auth/
```

The JSON Schema files document the persisted format. Implement strict runtime
validation using the repository's existing plain Node style; a new validation
framework is unnecessary for this pilot. Keep schema/validator behavior aligned
with shared positive and negative fixture cases. Production modules are CommonJS.

Keep Phase 1 fixtures under `test/fixtures/`, with their own synthetic PRD and
plans. Do not seed defects into an active project's specifications. Feature
creation/resolution helpers belong to Phase 2B; the checker takes explicit paths.

## 4. Feature context contract: `spec-context/v1`

### 4.1 Required fields

Reject unknown fields, missing required fields, wrong types, unsupported versions,
duplicate IDs, and out-of-range values. Do not coerce booleans, numbers, strings,
or enum values. All cross-references must resolve before semantic passes start.

| Field | Meaning and validation |
|---|---|
| `schemaVersion` | Exactly `spec-context/v1` |
| `featureId` | Stable lowercase slug, at most 64 characters |
| `featureDir` | Safe workspace-relative artifact directory |
| `sources` | Nonempty source catalog: unique `id`, safe `path`, exact raw-byte `sha256` |
| `requirements` | Complete accepted inventory: unique `id`, source location, `mandatory`, `acceptanceIds`, `riskTags` |
| `acceptanceCriteria` | Unique `id`, source location, related `requirementIds`, mandatory flag, required `checkIds` |
| `writeScope` | Explicit allow and deny lists, each entry typed as `file` or `directory` |
| `riskRules` | Reviewed path-specific rules with source/rationale and explicit `riskTags` |
| `checks` | Catalog of planned checks: unique `id`, nonempty string-array `argv`, positive integer `timeoutMs`, nonempty typed `verifierWritePaths` |
| `priorEvidence` | Catalog of existing planning evidence with unique IDs and resolvable source locations |
| `decisions` | Unique `id`, `resolved`/`unresolved` status, affected `requirementIds`, source/rationale, and resolution when resolved |

A source location is `{sourceId, startLine, endLine}`. Line ranges are 1-based,
inclusive, nonempty, and valid for the pinned UTF-8 source bytes. Define the same
LF/CRLF line-splitting rule in the implementation and fixtures; never normalize
bytes before hashing. Extracted text is used to construct assignment inputs and
acceptance criteria. A changed source hash requires rebuilding the baseline,
even if its line numbers still happen to match.

Requirement IDs need not have an `FR-` prefix. Acceptance IDs are explicit, and
every mandatory requirement has at least one acceptance criterion. Requirement
and acceptance links must agree in both directions. Each criterion has at least
one planned check. Nonmandatory items remain visible with `exclusionReason`
required when they are outside the pilot's required coverage.

Each check's `verifierWritePaths` grants permission to named test/check files or
bounded directories. Validate these paths against the same independent
`writeScope` and risk rules as implementation paths. An existing check that only
reads files still supplies bounded verifier paths because the effective verifier
role is workspace-write. These permissions do not require the verifier to edit.
Never infer them by parsing a command or by copying all implementation paths.

### 4.2 Scope is an independent input

An allow entry grants a bounded feature scope; a deny entry takes precedence.
A task's requested write path is valid only if its entire granted scope fits an
allow entry and does not intersect any deny entry.

- `file: src/auth/login.js` permits that file only.
- `directory: src/auth` permits descendants with path-segment boundaries.
- `src/auth-extra/x.js` is not contained by `src/auth`.
- Requesting parent directory `src` is invalid when only `src/auth` is allowed.
- Requesting a directory that includes a denied descendant is invalid, even if
  the task does not list that descendant separately.

Use existing safe-relative-path rules first, then containment and overlap checks.
For reads, resolve existing files and reject symlink escapes from the explicit
workspace root. For potential new write paths, inspect the nearest existing
ancestor and reject an escaping symlink or ambiguous file/directory declaration.
No glob, absolute path, backslash escape, empty path, `.` or `..` is accepted.
A lexical path check alone is insufficient.

These typed boundaries describe planning policy. Current harness `allowedFiles`
uses string paths with descendant-prefix matching; it does not encode the new
file/directory distinction. The offline checker must state this limitation.
Phase 2 must retain the trusted typed scope and check actual candidate effects
against it, including file-to-directory replacement, before claiming equivalent
runtime enforcement. Phase 1 does not silently strengthen existing write lanes.

The workspace root is a CLI argument established by the caller. Neither input
JSON document may replace it. The analyzer reads sources; it never creates a
proposed output directory to test whether that path would be writable.

### 4.3 Risk classification is explicit and reviewable

Allowed tags are `risk_change`, `performance`, and `component_complete`. An empty
list means reviewed ordinary work, rather than unknown risk.

For each task, compute the union of:

1. Tags of all linked requirements.
2. Tags of every matching risk rule for implementation writes and the selected
   checks' verifier write paths.
3. Any additional tags requested by the task author.

Every requested write path must match a reviewed risk rule. A missing rule or
unresolved risk decision blocks readiness. Tags cannot be subtracted in a map.

Derive one review kind with fixed precedence:

```text
risk_change > performance > component_complete > routine
```

Keep the full tag set in the report. The precedence chooses harness checkpoint
routing; it does not remove performance checks or component acceptance criteria.
Require the task's declared review kind to equal this derived kind. A task linked
to an auth requirement explicitly tagged `risk_change` cannot declare `routine`.

The checker does not infer security significance from names or keywords. The
independent context review is responsible for accurate labels and path rules.
A future semantic review may identify an untagged risk and require rebasing the
context; a structural pass cannot overrule that finding.

### 4.4 Prior evidence versus acceptance evidence

`priorEvidence` establishes the basis for planning, such as an existing PRD
clause, accepted decision, or inspected fixture. Each referenced artifact must
exist within the snapshot and have a verified source binding.

A planned check is not evidence that the check passed. Phase 1 verifies that
mandatory acceptance criteria have checks assigned to tasks and that assignments
have nonempty prior evidence. Actual test results and implementation review
receipts are collected after execution through existing harness mechanisms.
Reports keep these concepts separate:

- `missingPriorEvidence`: an assignment has no valid inspected basis.
- `missingPlannedChecks`: an acceptance criterion has no assigned required check.
- `implementationAcceptance`: always `not_evaluated` in Phase 1.

## 5. Task map contract: `spec-traceability/v1`

### 5.1 One representation of each relationship

The map has `schemaVersion`, `featureId`, `contextSha256`, `artifactBindings`,
and a nonempty `tasks` array. There is no second `coveredBy` list and no separate
`edges` array. Derive reverse coverage and graph edges from tasks, avoiding
contradictory copies of the same relationship.

Each task has the following required fields:

| Field | Rule |
|---|---|
| `id` | Unique stable ID matching `T` followed by 3-6 digits |
| `role` | Exactly `engineer` in Phase 1 |
| `objective` | Explicit, nonempty, bounded description |
| `requirementIds` | Nonempty unique references into the context inventory |
| `acceptanceIds` | Nonempty unique references into linked requirements' criteria |
| `dependsOn` | Unique task IDs; no self-reference or unknown ID |
| `parallel` | Boolean scheduling annotation; not execution authority |
| `writePaths` | Nonempty typed file/directory entries inside the context scope |
| `checkIds` | Nonempty unique references to approved check definitions |
| `priorEvidenceIds` | Nonempty unique references to the context evidence catalog |
| `stopConditions` | Explicit nonempty bounded strings supplied by the lead |
| `additionalRiskTags` | Explicit list; may strengthen the derived review kind |
| `declaredReviewKind` | Must match the kind computed under section 4.3 |
| `checkpointId` | Nonempty stable checkpoint identifier, at most 160 characters |
| `reviewReason` | Explicit bounded reason used in the immutable review context |

Phase 1 uses one checkpoint per material task for unambiguous qualification.
Batching related tasks into shared checkpoints can be added later with explicit
scope-union and review-context rules. Do not infer a shared checkpoint from a
matching title or requirement ID.

Task IDs remain stable when descriptions change. New work gets new IDs. Removed
or superseded work requires a recorded planning decision and a regenerated map;
renumbering tasks must not silently move old evidence onto different work.

### 5.2 Artifact bindings and human-readable projections

The checker accepts an explicit map path. In a later target project, the intended
artifact location is `specs/<feature>/traceability.json`.

`artifactBindings` pins the exact raw bytes of the derived `spec.md`, `plan.md`,
and `tasks.md` that the map was prepared against. Each entry has a role, a safe
workspace-relative path, and an expected SHA-256. Paths are relative to the
workspace, with no implicit mixture of feature-relative and root-relative paths.

Require exactly one binding for each of those three roles in the fixture.
The map does not contain its own digest; compute `mapSha256` externally to avoid
a circular hash. It cannot edit or substitute canonical `source` bindings from
the context.

For the pilot, define a narrow mapping block in `tasks.md`, compatible with
Spec Kit's checklist rows, rather than attempting to interpret unrestricted
Markdown prose. For example:

```markdown
<!-- harness-task-map:v1 begin -->
- [ ] T001 [US1] Implement password login in src/auth/login.js
- [ ] T002 [US1] Verify login failures in test/auth/login.test.js
<!-- harness-task-map:v1 end -->
```

Require exactly one nonnested begin/end marker pair. Parse that block for the
authoritative task ID inventory and checkbox state. Also scan the whole document
for checklist rows shaped as `- [ ] T001 ...` or `- [X] T001 ...`, accepting lower
case `x` as checked. A real task row outside the block is a blocking projection
error. Skip fenced examples and HTML comments using an explicit narrow scanner;
markers are recognized separately. Reject malformed/unclosed fences or comments
instead of silently hiding rows. Do not interpret arbitrary prose as task data.

Reject duplicate IDs, missing map tasks, and unknown checklist IDs inside the
block. Preserve Spec Kit's ordinary task description syntax. `[P]` annotations
must agree with `parallel`; check them against dependencies and overlapping
write scopes before reporting them as feasible.

The lead and reviewer inspect semantic agreement between task descriptions,
objectives, canonical intent, and artifact prose. Hashes prove which bytes were
inspected, not that their natural-language meaning agrees. Structural equality
of IDs does not establish semantic equality of descriptions.

### 5.3 Required graph and coverage invariants

1. Every task reference resolves to an existing object of the correct type.
2. Every mandatory context requirement is referenced by at least one task.
3. Every mandatory acceptance criterion is assigned, with all its required checks
   present among the tasks that explicitly cover that criterion.
4. Every task's acceptance IDs belong to its linked requirements. A task cannot
   borrow an unrelated criterion simply to make an array nonempty.
5. Every task has at least one requirement; support/setup tasks link to the
   requirement whose implementation they enable.
6. `dependsOn` is the sole graph representation. It forms a DAG with no dangling
   IDs or self-loops. Report a stable witness path for each detected cycle group.
7. `[P]` tasks cannot depend directly or transitively on another task with which
   they are proposed to run concurrently. Overlapping writes prohibit that
   concurrency, including parent/child scope overlap.
8. Known unresolved decisions that affect any linked requirement block its tasks.
9. The extracted `tasks.md` ID inventory equals the map task inventory, and no
   real task checklist row exists outside the canonical block.

The checker reports a stable topological order, breaking ties by task ID.
Phase 1 emits individual assignment proposals with `wave: null`; it does not
introduce a parallel scheduler. A positive parallelism annotation is diagnostic.

## 6. Complete assignment adapter

### 6.1 Field-by-field transformation

Compile every task. Do not qualify only a representative subset. If any task is
invalid, the feature has no passing readiness verdict.

| Assignment field | Deterministic source |
|---|---|
| `role` | Task `role`; Phase 1 permits `engineer` only |
| `objective` | Task `objective`, unchanged |
| `allowedFiles` | Sorted task write paths after independent scope validation |
| `inputs` | Stable requirement/criterion IDs plus source path, location, and extracted canonical text |
| `evidence` | Resolved prior-evidence references with ID, source path, location, and digest |
| `acceptanceCriteria` | Referenced criterion IDs and extracted canonical acceptance text |
| `checks` | Canonically rendered command data for the selected `checkIds`, as defined below |
| `stopConditions` | Task conditions plus fixed conditions for source/context drift and missing write scope |
| `skills` | Empty array in Phase 1 |
| `wave` | `null`; each proposal is validated in its own decision |
| `continueFrom` | `null`; historical attempts are outside offline planning |
| `review` | Full object constructed as below |
| `repair` | `null`; no invented live repair authority |

Construct the complete review object:

```json
{
  "kind": "risk_change",
  "checkpointId": "pilot-auth-T001",
  "reason": "Password authentication changes a trust boundary.",
  "paths": ["src/auth/login.js", "test/auth/login.test.js"],
  "evidenceIds": ["E-PRD-AUTH"],
  "prerequisiteFor": []
}
```

The kind comes from the context rules. The checkpoint and reason come from the
task. `review.paths` is the sorted, deduplicated union of the task's implementation
write paths and all selected checks' `verifierWritePaths`. The context must
independently allow this complete scope. The implementation assignment's own
`allowedFiles` remains its task write scope. Evidence IDs are the validated
prior-evidence IDs. Reuse this exact review object for that checkpoint's
subsequent verifier and, where required, auditor.

Render each check string as `CHECK <id> argv=<JSON array> timeoutMs=<integer>`,
using the approved `argv` and timeout without shell expansion or interpolation.
For example: `CHECK login argv=["node","--test","test/auth/login.test.js"]
timeoutMs=60000`, represented as one line in the assignment. This is structured
execution intent; Phase 1 never executes it. Check IDs, argument order, and
timeouts cannot be replaced by task-authored shell text.

Enforce existing contract limits, currently at most 20 entries per ordinary
assignment array and 3000 characters per entry/objective. Oversized source
excerpts require a narrower source span or a smaller task. Do not silently
truncate constraints, drop evidence, or split review context to fit the limit.

### 6.2 Reuse the exported contract, without changing live behavior

`checkAssignment` is currently private. Do not import a nonexistent export or
copy its implementation into the analyzer. Build a complete synthetic decision
for one assignment and call exported `validateDecision` on a defensive copy:

```json
{
  "action": "dispatch",
  "assignments": ["<compiled assignment object>"],
  "final": "",
  "resolutions": [],
  "humanInput": null,
  "goalAchieved": null,
  "acceptanceChecks": null,
  "records": []
}
```

The string in the example stands for the assignment object, not a literal string
in executable JSON. Load actual role definitions using `loadRoles()`. Supply an
explicit offline validation context: no open decisions, no unresolved writers,
no incomplete critical checkpoints, no continuations, empty attempted-role set,
and no selected skills. Record those assumptions in the report.

Also validate the compiled direct-specialist request using
`checkSpecialistRequest` with the effective engineer role and explicit workspace.
This checks endpoint shape; it is still not a model call or admission decision.
Construct that request by selecting `role`, `objective`, `allowedFiles`, `inputs`,
`evidence`, `acceptanceCriteria`, `checks`, `stopConditions`, `skills`, `wave`,
`review`, and `repair` from the compiled assignment, and setting `workspace` and
`reportContract: "worker-report/v1"` from trusted caller configuration. Omit
lead-only `continueFrom`. Omit `continuation`, `assignmentId`, `skillPins`, and
`requireAcceptance` in this offline request; no live attempt identity exists.

Both functions can normalize their arguments. Work on copies, record relevant
normalization, and do not mutate source JSON objects to make invalid inputs pass.
Unknown roles, missing fields, invalid review metadata, and bounds violations
become stable analyzer findings.

### 6.3 Planned review versus actual review

For every checkpoint, emit a review plan:

- `routine`: implementation, then verifier.
- Any gated kind selected by this pilot: implementation, then verifier, then
  auditor, with matching review context and successive execution groups.

Generate complete verifier/auditor assignment proposals with explicit objectives,
inputs, prior evidence, checks, stop conditions, and safe review scopes. Use the
same source-derived inputs, evidence, acceptance criteria, canonical check
strings, and stop conditions as the implementation proposal. Prefix the task
objective with `Verify checkpoint <id>:` or `Audit checkpoint <id>:` and retain
the exact immutable review object. Reject resulting size violations.

The workspace-write verifier receives the sorted, deduplicated union of selected
checks' `verifierWritePaths` as nonempty `allowedFiles`. The read-only auditor
receives `allowedFiles: []`. Both get their actual role ID, `skills: []`,
`wave: null`, `continueFrom: null`, and `repair: null`. For auditor check strings,
render `Assess planned CHECK <id>; verifier execution evidence is pending.` for
each selected check. This is read-only planning validation, not a claimed
execution result. Live auditor assignments will cite actual verifier evidence;
commands requiring output writes are not assigned to the auditor.
Validate each proposal through `validateDecision` in its own offline envelope
and through the corresponding role's `checkSpecialistRequest` projection.
Record the future evidence dependency without inventing a passing verifier
receipt. Review scopes include all candidate paths promised by the checkpoint.

This is a static plan for future evidence. `contracts.js` does not require an
already completed verifier/auditor pair when an engineer is dispatched. Actual
receipt freshness, writer settlement, and gate satisfaction remain in the
existing runtime, notably `src/lead-graph.js` and review policy code.

A valid offline proposal must be revalidated with the real run state before any
future execution. The analysis report must not describe that task as presently
admitted or accepted.

## 7. Snapshot, determinism, and report contract

### 7.1 Snapshot construction

Read context, map, canonical sources, and bound derived artifacts into immutable
buffers. Hash and parse those same buffers. Verify expected context/source/
artifact digests before graph or assignment passes. Never refresh an expected
hash automatically merely because the current file differs.

Use a domain-separated, ordered manifest for the final fingerprint:

```text
analysisFingerprint = sha256(stableJSON({
  contractVersion,
  featureId,
  checkerSourceHashes,
  harnessContractHashes,
  roleProfileAndTeamHashes,
  contextSha256,
  mapSha256,
  sources: sorted([{id, path, sha256}]),
  artifacts: sorted([{role, path, sha256}])
}))
```

`stableJSON` sorts object keys recursively and uses a specified bytewise ordering
for set-like arrays. Do not use locale-dependent ordering, timestamps, absolute
machine paths, or random identifiers in the deterministic result.

Hash the implementation files actually used by the checker, imported contract
helpers, role definitions, and TEAM rules; record their paths and digests in the
manifest. A bare Git HEAD does not identify uncommitted checker changes.

For Phase 1, use an isolated fixture with no writers. Re-read the input manifest
before returning and reject observed drift. This is drift detection, not a claim
of atomic multi-file reads under concurrent mutation. Phase 2 must bind its
check to writer reservation/admission and recheck before submission.

### 7.2 Output and exit codes

The CLI writes one JSON object to stdout, bounded diagnostics to stderr, and
never writes files or executes the planned commands. Shell redirection, if used
by a caller to retain evidence, is outside the checker and has an explicit
caller-owned destination.

Required report fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | `spec-analysis/v1` |
| `featureId` | Validated context identity |
| `analysisFingerprint` | Digest of the complete manifest; null if it could not be constructed |
| `inputManifest` | Actual bytes and versions assessed |
| `assumptions` | Offline run-state assumptions and semantic review boundary |
| `findings` | Stable code, severity, task/requirement ID, location, expected/actual details |
| `coverage` | All context requirements/criteria and their covering task IDs |
| `dependencyOrder` | Topological order or null when graph is invalid |
| `assignmentValidation` | Result for every implementation and planned review assignment |
| `reviewPlan` | Checkpoint contexts and required review sequence |
| `implementationAcceptance` | Exactly `not_evaluated` |
| `verdict` | `pass`, `review`, or `blocked` |

Verdict rules:

- `blocked`: any malformed/missing/stale input, invalid relationship, uncovered
  mandatory item, missing required evidence/check, cycle, scope violation,
  unresolved blocking decision, or failed assignment validation.
- `review`: structurally valid input with explicitly recorded nonblocking
  semantic questions that the lead must resolve before using the proposal.
- `pass`: every required structural check passes and no unresolved question
  remains in the accepted context. This does not mean implementation acceptance.

Exit codes: 0 for `pass`, 1 for `blocked`, 2 for `review`, 3 for internal failure.
When parse failure prevents a full report, emit a minimal structured blocked
report without fabricated fingerprints or partial success. Never use an internal
error as a passing or advisory-only result.

Sort findings by stable code, source path, task/requirement ID, and location.
Aggregate repeated findings without hiding affected IDs. Do not silently truncate
a report into a valid-looking incomplete coverage list.

### 7.3 Resource bounds

Initial pilot bounds: at most 100 tasks, 100 requirements, 200 acceptance
criteria, 32 source files, and 1 MiB each for context/map JSON. Bound individual
source/artifact files to 4 MiB and the total input snapshot to 32 MiB. Enforce
bounds before expensive graph or text processing. Existing assignment limits
still apply separately and can require much smaller individual tasks.

An exceeded limit is a blocked input with a clear diagnostic. Enlarging a bound
requires a documented fixture and resource review; it is not an implicit reason
to skip coverage validation.

## 8. Phase 1 execution interface

Proposed CLI contract:

```text
node tools/spec-kit/analyze.js \
  --workspace <absolute-target-workspace> \
  --context <workspace-relative-context-path> \
  --context-sha256 <digest-from-reviewed-baseline> \
  --map <workspace-relative-map-path> \
  --profiles <absolute-harness-profiles-directory> \
  --json
```

These flags describe code to be implemented; the command is not available yet.
Use explicit arguments for the pilot. Do not select the latest numbered feature,
consult the current Git branch, or modify `.specify/feature.json` in this checker.

The profiles directory is harness configuration supplied by the caller. A task
map cannot choose a different catalog to make its role validation succeed.

Separate pure passes from the filesystem boundary:

```text
loadSnapshot(arguments)
  -> validateContext(snapshot)
  -> validateMap(snapshot, context)
  -> validateSourceAndArtifactBindings(snapshot)
  -> analyzeReferencesCoverageGraphScopeRisk(context, map)
  -> compileAssignments(context, map)
  -> validateAssignmentProposals(proposals, harnessContracts, roles)
  -> buildReport(snapshot, findings, proposals)
  -> verifyNoObservedInputDrift(snapshot)
  -> emitReport()
```

Schema failure stops passes that require the invalid structure. The report must
identify which passes could not run; it must not report their absence as success.

The checker does not invoke package scripts, shell commands, Git, an SDK, A2A,
MCP, or network access. `checks.argv` is data for later approved execution.
No command from an input document is evaluated to discover its result.

## 9. Phase 1 qualification matrix

These are future implementation checks. They are not claims of tests run while
writing this plan. Use Node's existing test runner and disposable fixtures;
no live model call is needed.

### 9.1 Positive controls

- A complete representative feature passes with every mandatory requirement and
  criterion covered, every task compiled, and every assignment validated.
- A reviewed ordinary task receives `routine`; a tagged auth task receives
  `risk_change`; a performance-only task receives `performance`.
- A valid directory boundary admits its intended descendants, including a new
  file whose existing ancestors are contained by the target root.
- Independent task scopes can be reported as parallel; a dependency chain has a
  stable topological order.
- Repeated analysis of identical bytes/configuration produces byte-identical
  JSON output, including fingerprint, ordering, and full coverage.
- A JSON report remains separate from actual implementation acceptance.

### 9.2 Required negative cases

| ID | Seed | Expected result |
|---|---|---|
| Q01 | Mandatory canonical requirement omitted from map tasks | `blocked`, requirement ID reported |
| Q02 | Requirement covered but one mandatory acceptance criterion omitted | `blocked`, criterion ID reported |
| Q03 | Task has empty requirement references | `blocked`, orphan task |
| Q04 | Unknown requirement, acceptance, evidence, check, or dependency ID | `blocked`, dangling reference |
| Q05 | Duplicate task/requirement/criterion/check/evidence ID | `blocked`, duplicate ID |
| Q06 | Dependency self-loop or multi-task cycle | `blocked`, stable cycle witness |
| Q07 | Path contains `..`, an absolute path, a glob, or an empty segment | `blocked`, invalid path |
| Q08 | Safe relative path lies outside accepted feature scope | `blocked`, scope conflict |
| Q09 | Parent directory includes a denied child, or prefix only resembles allowed directory | `blocked`, scope conflict |
| Q10 | Existing path or nearest new-file ancestor escapes through a symlink | `blocked`, filesystem boundary conflict |
| Q11 | Parallel annotation conflicts with a dependency or overlapping writes | `blocked`, scheduling conflict |
| Q12 | Task has no valid prior evidence | `blocked`, missing prior evidence |
| Q13 | Mandatory criterion's required check is absent from covering tasks | `blocked`, missing planned check |
| Q14 | Criterion belongs to a different requirement | `blocked`, invalid coverage link |
| Q15 | Task declares `routine` but linked canonical tags/path rules require `risk_change` | `blocked`, risk mismatch |
| Q16 | A write path has no reviewed risk rule | `blocked`, unresolved classification |
| Q17 | Context or any canonical source digest changes | `blocked`, baseline mismatch |
| Q18 | Bound spec/plan/tasks changes without rebinding the map | `blocked`, artifact mismatch |
| Q19 | Map differs from the marked task inventory; a real task appears outside the block; markers/fences/comments are malformed | `blocked`, projection mismatch |
| Q20 | Map attempts to replace scope/root/context authority | `blocked`, schema/binding error |
| Q21 | Missing objective, incomplete review context, unknown role, empty stop conditions, or absent/out-of-scope verifier paths | `blocked`, contract/scope validation failure |
| Q22 | One invalid task among many otherwise valid tasks | Entire feature `blocked`; invalid task identified |
| Q23 | Overlong source excerpt or too many assignment items | `blocked`; no silent truncation |
| Q24 | Input file disappears or changes during analysis | `blocked`/error with no usable pass report |
| Q25 | Invalid JSON/version/type, boolean used for number, or unexpected field | `blocked`, shape error |
| Q26 | Input size/count exceeds the documented limit | `blocked`, bounded diagnostic |
| Q27 | Unresolved decision affects a task's source requirement | `blocked`, decision reference |
| Q28 | Prior plan/report is presented as proof of passing implementation checks | `implementationAcceptance` remains `not_evaluated` |

For negative cases, keep the accepted context digest fixed unless the test is
specifically about a changed baseline. Otherwise the fixture would merely test
that the checker accepts the newly expanded authority.

Include a deliberate semantic-control case: two task descriptions can have the
same IDs yet different meaning. The checker must not claim its structural pass
proves semantic agreement. That defect belongs to context/artifact review.

### 9.3 No-write and no-execution evidence

- Hash and inventory the complete disposable workspace before and after each
  read-only analyzer invocation, including `.specify` and symlink metadata.
- Verify that the analyzer creates no report, cache, template, lock, or database
  file. Permit output only in caller-designated test scratch storage.
- Use a planned check whose execution would create a sentinel. Confirm the
  sentinel does not exist after analysis.
- Exercise filesystem-boundary cases with disposable directories, not real
  project data.

The future focused command is:

```text
node --test test/spec-context.test.js test/spec-analyzer.test.js test/spec-assignment-adapter.test.js test/spec-analyzer-cli.test.js
```

After focused checks pass, run the existing `npm test` at milestone integration
under the project's normal execution permissions. Record unrelated baseline
failures separately; they neither prove an analyzer defect nor become green by
being omitted. Repeat checks when their inputs change or a concrete risk remains.

## 10. Phase 1 work breakdown and acceptance

Use the smallest team that closes the actual evidence gaps. Sequence shared-file
work; no parallel writers on `src/spec-analyzer.js`.

| Step | Owner | Deliverable and allowed files | Acceptance |
|---|---|---|---|
| P1.0 | Lead with explorer if needed | Consume accepted AUT-05 baseline; bind its feature to the AUT-01 context/inventory | Exact baseline reference, scope, IDs, semantic limits, risk rules, and unresolved decisions are explicit |
| P1.1 | Engineer, gpt-6-luna | `schemas/spec-*-v1.schema.json`, `src/spec-context.js`, owned fixture files | Strict types, IDs, source locations, scope/risk/check/evidence catalogs; fixed context digest |
| P1.2 | Engineer, gpt-6-luna | `src/spec-analyzer.js`, `test/spec-analyzer.test.js` | Coverage, references, graph, path containment, risk rules, artifact binding, stable findings |
| P1.3 | Engineer, gpt-6-luna | `src/spec-assignment-adapter.js`, `test/spec-assignment-adapter.test.js` | Every implementation/review proposal passes actual exported contract validation or produces a specific failure |
| P1.4 | Engineer, gpt-6-luna | `tools/spec-kit/analyze.js`, `test/spec-context.test.js`, `test/spec-analyzer-cli.test.js` | Explicit arguments, snapshot fingerprint, exit codes, bounded errors, zero writes/execution |
| P1.5 | Verifier, gpt-6-luna | Explicit named test/fixture/check paths in a later wave | Positive controls and all applicable Q01-Q28 cases; actual diff inspected |
| P1.6 | Auditor under existing policy | Read-only integrated candidate and evidence | Independently assess scope/risk interpretation, contract claims, and persisted format boundaries |
| P1.7 | Lead, documentation delegated as needed | Accepted pilot result and backlog status/evidence links | Limitations recorded; Phase 1 result does not imply Phase 2 qualification |

Give P1.1-P1.4 explicit existing harness review contexts. Treat the new persisted
formats and scope/risk interpretation as a `risk_change` milestone for this
implementation; use a passing verifier followed by auditor before dependent
runtime work. This review does not make the analyzer itself an acceptance owner.

Keep evidence in the existing staging/evidence mechanism once implementation
exists, with stable problem/checkpoint IDs and references rather than raw private
conversations. Use `.agents/teamwork/` for transient coordination when writable;
its ignored content is not a tracked product deliverable.

Phase 1 is complete only when:

- The accepted AUT-05 baseline reference and its supported comparison scope are
  retained; AUT-01 outputs do not overwrite baseline artifacts.
- Both contracts are documented, strictly validated, and represented by the
  fixture manifest with exact accepted source/context digests.
- Every task and its planned reviews are compiled and checked; no sampling.
- Coverage is calculated against the independent mandatory inventory.
- Q01-Q28 and positive controls have concrete results, with any inapplicable case
  explained and no skipped mandatory AUT-01 class.
- Filesystem scope, no-write behavior, and nonexecution are evidenced.
- Focused and existing project checks have recorded outcomes.
- Verifier and required auditor evidence cover the integrated candidate.
- The lead records a bounded AUT-01 pilot result and remaining semantic/runtime
  limitations. AUT-02/AUT-03/AUT-04 remain unqualified.

## 11. Phase 2A: optional runtime dispatch integration

### 11.1 Entry criteria and files

Start after accepted Phase 1 evidence, with an explicit feature enrollment design.
Likely files: `src/lead-graph.js`, `src/lead-orchestrator.js`, applicable state/
contract modules, direct role service/admission code if covered, and focused
integration tests. Assign exact files after tracing the current dispatch paths.

This phase changes runtime behavior. A skill attachment is not the feature flag
and must not be the only indication that a task requires analysis.

### 11.2 Trusted feature enrollment

Bind the run, workspace, feature ID, accepted context digest, map digest, and
analysis policy version in harness-owned state. Link each derived assignment to
its map task through trusted dispatch construction. A worker-supplied skill ID,
feature path, or `pass` report cannot establish enrollment or grant authority.

Specify the persisted shape, ownership, restart behavior, and migration strategy
before editing state contracts. If assignment or specialist request fields need
to change, update their strict schemas, parsers, validation, prompt projection,
request construction, and direct endpoint tests together. Unknown extra fields
currently fail; do not rely on an informal metadata field surviving every layer.

### 11.3 Admission and freshness

For an enrolled implementation task:

1. Resolve its trusted context/map binding.
2. Verify every canonical source and artifact binding with the current checker
   and contract/profile versions.
3. Run analysis or reuse a report only when its complete fingerprint still
   matches; a caller's claimed verdict is not sufficient.
4. Confirm the compiled assignment equals the proposed scope, checks, source
   references, and review context. A valid map cannot authorize a different task.
5. Apply current run-state validation, review obligations, owner pause, budget,
   and unresolved-writer gates.
6. Recheck the binding under the writer reservation/admission boundary before
   submission. Input changes or unknown state prevent a model call.

Retain the trusted typed scope through execution and writer settlement. Compare
the actual candidate delta, including path types and renames, against that scope
before integration. Existing prefix-based `allowedFiles` checks alone cannot
enforce the pilot's exact-file policy. An effect outside the typed scope remains
isolated and cannot be accepted from a passing pre-dispatch report.

Missing context/map, parse failure, unknown input version, stale fingerprint,
`blocked`, `review`, or analyzer failure must prevent that enrolled writer from
starting. Emit a bounded reason and return the lead to repair/replanning. Do not
invalidate unrelated existing runs or force unenrolled features to create maps.

A changed canonical requirement invalidates both context and all dependent
reports. A changed derived plan/task/map requires map reconciliation and fresh
analysis. A changed implementation candidate invokes existing review freshness
rules even if the planning fingerprint is unchanged. These are different checks.

### 11.4 Entrypoints and recovery

Document exactly where the new gate applies:

- Lead dispatch of enrolled assignments.
- Usage-limit continuation and retry after restart.
- Any direct specialist endpoint that can execute enrolled work.

If direct requests lack a trusted run binding, either reject enrolled direct
writes or route them through the same trusted admission service. Never claim a
runtime-wide guarantee from a lead-only hook. A first bounded increment may
qualify only lead dispatch, but must state that limitation and cannot count
direct endpoints as covered.

Persist a compact analysis reference and input manifest with the assignment
journal. Preserve historical failed attempts and reports. Recompute after a
checker/context change; do not mutate old evidence to resemble a fresh pass.

### 11.5 Required integration cases

- Enrolled valid work dispatches; uncovered requirements prevent submission.
- Missing/invalid map or checker error causes zero model calls.
- Canonical source, task map, role profile, or contract drift invalidates reuse.
- Changes between planning and writer reservation are rejected.
- An assignment cannot expand a passing task's paths/checkpoint context.
- Candidate effects cannot replace an exact-file grant with a directory grant,
  introduce a symlink escape, or use a rename to cross the trusted scope.
- Owner pause, budget denial, unresolved writers, and critical review gates
  remain effective regardless of analysis verdict.
- Restart, retry, continuation, and each claimed direct endpoint follow the same
  policy without authorizing stale reports.
- Unenrolled ordinary work retains its existing behavior.

Accept this runtime milestone with fresh verifier then auditor evidence. Rollback
must address persisted enrollment state explicitly: stop enrolled dispatches,
retain evidence, and use an assessed transition rather than silently bypassing
the stored policy by removing a skill.

## 12. Phase 2B: adapting the local Spec Kit workflow

### 12.1 Delivery choice

Use harness library skills only if the artifact pilot justifies their added
prompt/context cost. Adapt the source commands; do not copy them verbatim.

Proposed worker skills are:

| Skill | Local Spec Kit source | Harness responsibility |
|---|---|---|
| `spec-kit-constitution` | `templates/commands/constitution.md`, constitution template | Governed changes to existing principles; separate scope/checkpoint |
| `spec-kit-specify` | Specify command and spec template | Derived feature spec and requirements checklist |
| `spec-kit-plan` | Plan command, plan template, setup-plan contract | Design artifacts from canonical intent |
| `spec-kit-tasks` | Tasks command/template, setup-tasks contract | Checklist tasks plus reconciled machine map |
| `spec-kit-analyze` | Analyze command | LLM semantic findings, kept separate from deterministic AUT-01 result |
| `spec-kit-implement` | Implement command | Bounded execution, task-state updates, worker report |
| `spec-kit-converge` | Converge command | Append-only gap tasks; no implementation acceptance |

Catalog selection permits at most five skills per assignment. Attach only the
procedure needed for that bounded step. Record the upstream source revision and
hashes, adaptation changes, and final skill SHA-256. Inspect the upstream license
and retain required license text for redistributed source material.

Do not conflate the three delivery surfaces:

1. Harness catalog skills, attached/pinned by assignment.
2. Spec Kit's project-local agent skills, which its Codex integration can install
   using `--integration codex --integration-options="--skills"`.
3. The harness role's Codex bundled-skill toggle in `[a2a_tools]`.

Installing project skills or setting the bundled-skill flag does not demonstrate
that a harness assignment received a particular pinned procedure. Qualify actual
prompt delivery for whichever route is chosen.

### 12.2 Feature creation and resolution

Keep creation and lookup separate when helpers are introduced:

- Creation uses an explicit feature directory, or the configured sequential/
  timestamp naming mode when that compatibility is implemented. It creates one
  feature and persists its path in `.specify/feature.json` within assigned scope.
- Resolution uses explicit `SPECIFY_FEATURE_DIRECTORY`, then the persisted
  `feature_directory`, then fails. It never chooses the next feature number.
- Read-only resolution never persists an environment override. This corresponds
  to upstream no-persist behavior and keeps analyze read-only.
- Plan setup preserves an existing plan. Upstream setup can create directories
  and copy a template; a helper retaining that behavior must have write scope.
- Tasks setup requires spec and plan, enumerates optional research/model/contract/
  quickstart documents, and supplies the selected tasks template.

Use collision checks and serialized feature creation if more than one feature
can be created concurrently. Feature directory and Git branch are independent.
The harness pilot does not change branches. Initially support only core pinned
templates; preset/extension override resolution is a separate compatibility item.

### 12.3 Effects that must be adapted explicitly

The local command bodies include behaviors beyond writing the named primary
artifact. The adaptation must deal with each one:

- Remove `.specify/extensions.yml` pre/post hooks and `EXECUTE_COMMAND` protocols
  from the pilot. A hook cannot introduce unreviewed commands or authority.
- Replace slash/agent-skill invocation with bounded A2A dispatch and the existing
  `worker-report/v1` result contract.
- Route plan research to lead-owned tasks, or keep it within the assigned worker;
  the adapted worker cannot spawn its own agents.
- Replace interactive checklist confirmations with an explicit reported blocker
  for lead resolution. Do not silently proceed through incomplete prerequisites.
- Disable automatic ignore-file changes unless those exact paths were assigned.
- Never let constitution drafting silently replace accepted project principles.
- Resolve constitution reads and writes to the same explicit workspace-relative
  `.specify/memory/constitution.md`. Upstream command bodies also contain
  integration-specific `/memory/constitution.md` references; replace them during
  adaptation rather than reading a host-root path or creating a second file.
- Keep `analyze` read-only. Its semantic findings do not overwrite canonical or
  derived documents and do not override deterministic blockers.
- Keep `converge` append-only for `tasks.md`; compare the original prefix bytes.
  A clean result leaves the file byte-identical. Additional reconciliation of the
  machine map is a separate lead-owned planning step. Newly appended checklist
  rows outside the mapping block deliberately block analysis. A subsequent
  assigned artifact-reconciliation step relocates only the block end marker to
  include the appended phases, preserves task rows/IDs, updates the map, and
  refreshes artifact bindings. That step is distinct from append-only converge;
  its full diff is reviewed before implementation can resume.

The existing engineer can author feature artifacts under bounded scope. Add
`spec-author` only if a separate instruction profile materially improves results;
if added, pin gpt-6-luna/high and keep its writable scope to assigned artifacts.
Use an existing read-only role for semantic analysis first; add `spec-analyzer`
only if it needs a durable distinct contract. A new role name is not isolation.

### 12.4 Ownership and full feature loop

Do not claim permanent artifact/code separation while the implementation worker
also marks `tasks.md`. Assign that update explicitly, or delegate completion
marking to the artifact owner after inspecting execution evidence. Serialize
`tasks.md` writes with convergence and map reconciliation.

The target sequence is:

1. Lead binds canonical context, including requirements, decisions, scope, checks,
   risk rules, and prior evidence.
2. Author derives spec and plan, preserving unresolved decisions as blockers.
3. Author derives tasks; lead reconciles the machine map and artifact bindings.
4. Deterministic analysis runs; semantic analysis is added when useful. Resolve
   findings explicitly and regenerate stale projections.
5. Lead dispatches ready tasks through existing writer/review gates. No skipped
   dependency or scope expansion is inferred from a checklist.
6. Integrate implementation; run verifier and required auditor against the actual
   current candidate. Update task state only from observed execution evidence.
7. Run converge against current code, intent artifacts, and constraints. Its
   upstream machine outcomes are `tasks_appended` and `converged`.
8. On `tasks_appended`, inspect new tasks, reconcile IDs/authority/checks/risk and
   the map, update bindings, re-analyze, and return to implementation.
9. On `converged`, confirm no required work remains and existing current-target
   acceptance evidence still covers the candidate. Only the lead can finish.

An LLM convergence result never replaces acceptance. Code changes invalidate
relevant candidate receipts; artifact changes invalidate relevant planning
reports. Both mechanisms remain effective through repeated iterations.

Use the existing run budget and stop conditions. Repeated no-progress gaps lead
to reassessment with evidence; do not create an unbounded automatic loop or
invent a new owner escalation merely because a fixed round count elapsed.

### 12.5 Workflow milestone acceptance

Qualify one feature with the pinned gpt-6-luna worker procedures and existing
review roles. Seed at least one remaining-work gap that makes converge append a
task, then demonstrate its implementation, fresh checks, and eventual
`converged` result. Include a no-gap control with zero convergence writes.

Evidence must identify exact prompt/skill versions, source/map fingerprints,
assignment scopes, candidate identities, review receipts, convergence results,
and actual usage. New role/skill delivery cannot be accepted from successful
catalog loading alone.

## 13. Phase 3: AUT-02, AUT-03, AUT-04, and measures

### 13.1 AUT-02 regression

Use the historical `review_origin_stale` incident as a regression source. The
actual code contains multiple stale-target paths; exercise the relevant
continuation and origin validation boundaries rather than relying on a label.

Demonstrate rejection before model execution, followed by a fresh verifier and
required auditor bound to the exact current candidate and immutable checkpoint
context. No repeated stale continuation, weakened gate, or reused historical
origin may count as recovery. Run this with fake transports first.

### 13.2 AUT-03 lead skill

Trial one versioned, hash-pinned decomposition skill delivered to the lead. It
consumes canonical context and produces a roadmap, task map, and readiness
report. The seven worker procedures do not satisfy this requirement.

Design and verify the actual lead prompt delivery path before adopting it;
`assignment.skills` currently describes worker assignment delivery. Preserve
pins and required review context across full/delta prompts and resumed runs.

Measure explicit-constraint preservation, unresolved-decision detection,
coverage, dependency correctness, assignment validity, prompt growth, elapsed
time, and cost. Retain the skill only after comparing with a recorded baseline
using the same tasks, model settings, budgets, and acceptance rules.

### 13.3 AUT-04 tools

Add read-only structured evidence tools only when recorded failures show existing
interfaces cannot retrieve the needed canonical run-scoped data reliably. Scope
lookups to the authorized run. Report typed evidence with provenance; tools do
not grant mutation authority or decide review freshness.

Spec Kit's MCP command catalog is not automatically the required evidence API.
Inspect command side effects before choosing a subset. CLI/MCP installation
remains a separate decision, based on evidence rather than assumed necessity.

### 13.4 AUT-05 baseline and measurements

AUT-05 begins in Phase 0 under [its implementation runbook](aut-05-baseline-runbook.md)
and continues here; it is not first implemented in Phase 3.
Record the baseline before the intervention being evaluated. Phase 1 can measure
structural detection deterministically; it cannot claim live model-cost or
accepted-feature improvements without those runs.

For later workflow comparisons record:

- Exact feature/corpus revision, canonical context, checker, skills, role models,
  reasoning settings, runtime version, and budget.
- First-pass accepted checkpoints and accepted final features.
- Repair/review rounds, preflight rejections, and owner escalations.
- Elapsed time, measured tokens, and measured cost per accepted result.
- Unknown measurements and the reason they remain unknown.

Predeclare retention thresholds for the particular trial before running it.
Zero mandatory-constraint loss, zero unauthorized scope expansion, and all
required gates passing are hard requirements. Cost/prompt tradeoffs can be
assessed only after those requirements hold. A single feature is a bounded
pilot, not evidence of broad model superiority.

## 14. Rollout, rollback, and unresolved product decisions

Phase 1 rolls out as a standalone tool invoked explicitly on an isolated fixture.
Stopping its use changes no existing run-state contract. Preserve accepted maps
and reports as evidence rather than deleting them to manufacture a clean state.

Phase 2 enrollment remains off for ordinary work until qualified. Define recovery
and rollback of any new persisted state before enabling a live feature. Removing
a skill is not sufficient rollback of an active runtime policy.

After each phase, the lead records one of: qualified within the demonstrated
scope, needs a bounded repair, or deferred with evidence. Backlog statuses name
the accepted phase; they do not mark all AUT items complete together.

The following decisions remain intentionally evidence-driven:

1. Whether the Phase 1 artifact model improves planning enough to retain.
2. Whether runtime enforcement is justified, and which entrypoints its first
   increment must cover.
3. Whether distinct artifact-author/analyzer profiles improve on existing roles.
4. Whether the optional lead skill or project-local/CLI/MCP delivery adds enough
   value to retain after measurement.

No unresolved decision in this list prevents implementation of the specified
Phase 1 checker and its controlled fixture. Actual source/risk/scope ambiguities
in the chosen feature must be resolved or represented as blocking decisions
before that feature can receive a passing readiness report.

## 15. First implementation brief

Start with AUT-05 runbook B0-B1, then progress through B2-B6 to an independently
reviewed `baseline_ready` handoff. Preserve all unrelated working-tree edits.

Next, execute P1.0-P1.1: bind the frozen representative feature, establish its
complete canonical inventory and independent scope/risk context, then implement
the two strict AUT-01 contracts and their fixtures.

Before dispatching the next implementation task, inspect its actual output and
confirm the context/map boundary and source bindings. Continue through P1.2-P1.7
in dependency order. Do not begin by creating seven skills, new roles, or a
`lead-graph.js` hook: those depend on accepted artifact-model evidence.
