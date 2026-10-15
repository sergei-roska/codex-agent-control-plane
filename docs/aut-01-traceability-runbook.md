# AUT-01 implementation runbook after the AUT-05 review

Status: implementation instructions. The completed offline Phase 1 qualification
and exact acceptance are recorded in [the AUT-01 review](aut-01-review.md).
A0 remains mandatory for a new or changed pilot baseline.

## 1. Mission

Implement Phase 1 of [the Spec Kit integration plan](spec-kit-luna-integration-plan.md):
a deterministic, read-only requirement-to-task checker and a complete harness
assignment adapter. Use the accepted AUT-05 corpus as the measurement foundation.

The previous AUT-05 handoff's `baseline_ready` statement is not sufficient entry
evidence. [The AUT-05 review](aut-05-review.md) records defects, corrective evidence,
and the final readiness decision. Read that decision and the exact manifest it
names; do not select a baseline by filename, timestamp, or a passing summary.

This task adds no runtime dispatch hook, model call, installed skills, new agent
roles, database migration, or live project activity. The deliverable is an offline
checker, its agent-facing report, and reproducible qualification evidence.

## 2. Entry checkpoint A0

Before editing implementation files:

1. Read the current handoff, Git status, parent plan, AUT-05 runbook, metric
   definitions, and final AUT-05 review. Preserve unrelated changes.
2. Resolve the exact accepted corpus/baseline/observation references and digests
   from the final review; use the corrected cohort rather than submitted v1.
3. Run the corrected AUT-05 evaluator on that explicit cohort with its trusted
   workspace root. Confirm successful input/digest validation and the declared
   evidence scope. `eligibility.ready` intentionally stays false because the
   evaluator does not grant acceptance; read the independent readiness decision.
4. Verify the baseline planning artifact's capture provenance. The repaired
   baseline is a manually authored current-lead planning artifact, not an
   exported historical harness run or a paid-model benchmark.
5. Confirm that AUT-01 code/skills were absent when the accepted artifact was
   captured. Retain all original baseline bytes and the rejected sample's status.
6. Record implementation source, schema, role, and contract hashes. A Git commit
   alone does not identify uncommitted input changes.

Proceed only for the comparison scope accepted in the review. An offline artifact
baseline supports tests of structural detection and task-map readiness. It does
not support claims about live model quality, token savings, elapsed execution,
first-pass accepted checkpoints, or measured monetary cost.

A missing accepted manifest, unavailable required artifact, digest mismatch, or
contradictory source/configuration blocks A0. Repair the evidence boundary; do not
silently upgrade a submitted draft to an accepted baseline.

## 3. Actual representative feature and qualification fixtures

Use the frozen F2 repair input from the corrected AUT-05 cohort. Its canonical
source is `bench/fixtures/f2-repair/` in this repository:

- Correct `applyDiscount` for a whole-number percentage.
- Preserve zero-percent behavior and existing subtotal/withTax tests.
- Keep the existing product tests unchanged.
- Restrict product changes to `src/price.js`.
- Plan the existing fixture check and independent review; do not claim execution.

Read the accepted inventory and assessment rather than copying the submitted
0/5 score. Lack of literal requirement IDs is a traceability limitation, not proof
that an otherwise explicit substantive constraint was lost.

Create an isolated checker fixture with a clear filesystem boundary:

```text
test/fixtures/spec-kit/pilot-price/
  canonical/                 # Pinned source/requirement excerpts
  product/                   # Byte-preserving copy of the bounded F2 target
    src/price.js
    test/price.test.js
    package.json
    CHECKS.json
  verification/checks/       # Separate, explicit verifier operational scope
  specs/pilot-price/
    spec.md
    plan.md
    tasks.md
    traceability.json
  context/pilot-context.json
  context/accepted-context.json
```

The fixture root is the checker workspace. Product write scope permits only
`product/src/price.js`. Product tests/check definitions remain protected.
Explicitly allow only the selected `verification/checks/` paths for the
workspace-write verifier's operational permission; these are outside the copied
product tree and do not relax the product change boundary. The accepted context
must include that separate permission before proposals can validate.

The offline checker never executes the planned repair/checks. The original F2
source intentionally contains a failing test; a valid planning report is not a
claim that the unrepaired product passes tests.

F2 is a small one-implementation-task feature. Do not invent business work just
to force parallelism or an auth boundary into it. Supplement it with clearly
synthetic, separately pinned qualification cases for multi-task graphs,
parallel-write conflicts, gated risk labels, and broader scope containment.
These cases are regression controls, not historical model-workflow observations.

## 4. Implementation ownership and files

| Component | Files | Contract |
|---|---|---|
| Independent feature context | `schemas/spec-context-v1.schema.json`, `src/spec-context.js` | Reviewed source inventory, scope, risk, evidence, checks, decisions |
| Derived task map | `schemas/spec-traceability-v1.schema.json`, owned fixture map | Stable task references and one dependency representation |
| Analyzer | `src/spec-analyzer.js` | Coverage/graph/scope/risk/binding findings with no mutations |
| Assignment adapter | `src/spec-assignment-adapter.js` | Complete implementation and planned review proposals |
| Explicit-input CLI | `tools/spec-kit/analyze.js` | Trusted root/context digest, bounded snapshot reads, JSON report |
| Qualification | `test/spec-context.test.js`, `test/spec-analyzer.test.js`, `test/spec-assignment-adapter.test.js`, `test/spec-analyzer-cli.test.js` | Independent positive/negative controls |

The lead owns context acceptance, the preserved AUT-05 baseline, and final scope.
Engineers own bounded implementation paths. Verifier and auditor review the
integrated candidate through the existing policy. Keep shared module edits
sequential. Do not let an implementation worker approve a modified context to
make its proposed task pass.

## 5. A1: independent context and strict schema

Implement the context contract from parent-plan section 4 before the task map.
Load the expected context digest from the caller's accepted context reference,
not from `traceability.json`.

Required behavior:

- Strict types, exact supported version, bounded inputs, and unique stable IDs.
- Complete mandatory requirement and acceptance inventory with resolvable source
  locations and raw-byte digests.
- Typed allow/deny scopes with segment-aware containment and deny precedence.
- Symlink/ancestor checks for existing and potential new paths under the explicit
  workspace root; no absolute path or traversal from input JSON.
- Approved check catalog with `argv`, timeout, and explicit verifier write paths.
- Prior evidence distinguished from planned checks and future review receipts.
- Risk labels from reviewed requirements/path rules, with unknown classification
  blocked and no keyword-based auth inference.
- Explicit unresolved decision references; affected tasks cannot be ready.

Document the semantic boundary: a deterministic checker validates coverage of an
accepted inventory. Independent review establishes completeness and interprets
arbitrary canonical prose. Hashes do not prove semantic agreement.

A1 acceptance: valid F2 context loads, unsafe/unknown/contradictory inputs fail,
and changing either canonical bytes or the accepted context digest invalidates
use without changing any artifact.

## 6. A2: task map, projection, and graph

Implement the parent-plan section 5 map contract. Use `dependsOn` as the only
graph representation and derive reverse requirement coverage from task links.
Reject unknown references and duplicate IDs before running dependent passes.

Parse the explicitly marked task block in `tasks.md`. A real checklist task row
outside that block is a blocking projection error, including future convergence
appends. Scan bounded Markdown with explicit fence/comment handling; malformed
markers or unclosed constructs cannot hide untracked work.

Compute coverage from the context's mandatory inventory, not from the task map's
own claimed completeness. Every mandatory criterion has the required planned
checks among its covering tasks. Every task links to at least one requirement
and valid acceptance criterion.

Validate self-loops, dangling edges, cycles, transitive dependency conflicts,
and overlapping proposed parallel writes. Output a deterministic topological
order. Emit separate assignment proposals with `wave: null`; no scheduler is
introduced in this milestone.

A2 acceptance: every listed graph/reference/projection seed is detected, with
stable affected IDs and cycle witnesses. Synthetic graph cases remain labeled
as such rather than attributed to the original F2 workflow.

## 7. A3: complete assignment and review adapter

Compile every map task; one invalid proposal blocks readiness for that feature.
Do not validate a selected sample only.

Reuse current exported `validateDecision` and `checkSpecialistRequest` on copies.
`checkAssignment` is private. Supply the explicitly documented offline context,
then state that live run-state validation is still required before dispatch.

The transformation must provide all ordinary fields, including an explicit
objective, nonempty inputs/prior evidence/checks/acceptance/stops, bounded paths,
empty Phase 1 skills, null continuation/repair, and the full immutable review
object. Never truncate a constraint to fit contract limits.

Review paths are the union of implementation paths and selected verifier check
scopes. Verifier allowedFiles is its independently allowed operational scope;
auditor allowedFiles is empty. Use the exact same review kind, checkpoint,
reason, paths, evidence IDs, and prerequisite list for the checkpoint sequence.

Risk rules select `routine`, `risk_change`, `performance`, or
`component_complete` with the parent-plan precedence and retained tag set.
Static review plans require verifier and, for gated work, auditor in later
execution groups. They do not fabricate actual passing receipts.

A3 acceptance: valid proposals pass both relevant exported boundaries; missing
fields, oversized evidence, scope conflicts, lowered risk, malformed reviewer
scope, and an invalid task among otherwise valid tasks all fail explicitly.

## 8. A4: snapshot/report/CLI

Implement parent-plan sections 7-8 with these additional review lessons from
AUT-05:

1. Hash the same immutable buffers that are parsed; require all expected digests.
2. Pin context, map, canonical sources, derived artifacts, checker/contract
   implementation, and role/team inputs. Verify actual bytes, not hash syntax.
3. Validate all claimed reference membership. A correct corpus/map hash does not
   excuse a different source snapshot or unrelated evidence record.
4. Read under an explicit trusted root; reject path/symlink escapes and bounded
   resource-limit violations before large allocations.
5. Recheck observed drift before returning. Document that this is an offline
   frozen fixture and not an atomic snapshot under concurrent writers.
6. Return structured nonthrowing findings for malformed nested input. A null
   array member must not cause a TypeError or accidentally count as success.
7. Keep report status, case outcome, structural readiness, and project acceptance
   separate. `implementationAcceptance` remains `not_evaluated`.
8. Emit JSON to stdout and bounded diagnostics to stderr. No files, cache, DB,
   shell commands, Git operations, models, or planned checks are executed.

Implemented Phase 1 command:

```text
node tools/spec-kit/analyze.js \
  --workspace <absolute-frozen-fixture-root> \
  --context context/pilot-context.json \
  --context-sha256 <digest-from-accepted-context-reference> \
  --map specs/pilot-price/traceability.json \
  --profiles <absolute-harness-profiles-directory> \
  --json
```

Use parent-plan report fields and exit codes. Missing canonical inputs,
parse/validation failures, and incomplete passes cannot produce a valid-looking
`pass` report.

## 9. A5: independent qualification and baseline comparison

Run all parent-plan Q01-Q28 cases and positive controls. Add explicit controls
for the review defects fixed in AUT-05: null nested objects, unknown/dangling
references, mismatched versions/bytes, empty evidence lists, false pass claims,
and incomplete metric denominators.

Compare the accepted frozen manual planning artifact and the derived AUT-01 map
against the same mandatory inventory. Report separately:

- Substantive requirement preservation, using independently assessed clauses.
- Explicit machine traceability and dispatch-contract validity.
- Seeded-defect detection and false-positive behavior.
- Actual checker execution measurements, clearly separated from unavailable
  model/workflow/token/spend measurements.

Do not claim that converting free text into explicit IDs improved substantive
requirements from 0/5 to 5/5 unless independent semantic scoring proves that.
Do not compare illustrative examples with observed workflow measurements.

Run focused checker tests first, then existing project checks at integration.
Use an invocation that executes leaf tests in the actual environment; retain
exact command, Node version, leaf counts, failures, and source hashes. A runner
listing only files is insufficient evidence of expected leaf coverage.

Collect actual diff and implementation evidence. A passing model report, default
lifecycleStatus, or evaluator exit code does not replace independent acceptance.
Require verifier then required auditor on the integrated persisted-format/scope
boundary changes. Keep failed attempts and findings with their exact targets.

## 10. Completion and next handoff

AUT-01 Phase 1 is complete when:

- A0 baseline entry evidence remains resolvable and unchanged.
- Both contracts, analyzer, adapter, and CLI satisfy their specified boundaries.
- Every derived implementation/review proposal is validated; no sampling.
- All mandatory coverage and qualification cases have actual outcomes.
- Read-only/no-execution properties and actual digest verification are evidenced.
- Independent review covers the final source/fixture versions.
- AUT-05 comparison records the supported capability result and remaining unknowns.

Retain a compact handoff with input/output manifests, accepted context digest,
changed files, exact verification results, known limitations, and the next
bounded decision. No automatic enrollment, model/provider installation, live
feature execution, or runtime gate follows from this offline milestone.

After this result, reassess the parent roadmap. A runtime gate and a lead-facing
AUT-03 skill are separate interventions with their own technical plans, review,
and comparison baselines; their implementation is not part of this runbook.
