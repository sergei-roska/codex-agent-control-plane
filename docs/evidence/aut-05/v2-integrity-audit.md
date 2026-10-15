# AUT-05 integrity audit result

Verdict: REJECT
Status: complete
Scope expansion: none

Blocking: test/fixtures/autonomy/corpus-v2/observations.json:405 [read]:
`obs-failed-incomplete-usage` claims one real historical failed/incomplete
result with missing usage, but gives no run, task, assignment, or attempt ID and
states that no complete source report or case execution is included. Its only
evidence artifact, historical-source-evidence.md:18, says handoff summaries
identify an incomplete usage event and an auditor failure without joining them.
The corpus points to r212/r227 failures and TOK-OPT-01. The former are dated
2026-10-15 in monitor-owner/handoff.md; the latter is a 2026-10-13 usage
snapshot with 14 unspecified unknown rows in root/token-optimization-review.md.
Those records cannot establish that a failed result and missing usage belong to
the same attempt. The CLI checks local hashes and structural joins, but has no
source record to validate this historical semantic join. Runbook section 6
requires an actual target implementation or recorded execution for each case;
section 10 criterion 2 requires accepted provenance. Pin one concrete failed
attempt and its usage-unavailable evidence, or replace this control with a
supported frozen failed/incomplete observation; then recapture a new immutable
baseline revision and review it.

## Criteria, section 10

1. PASS [read]: Seven v2 cases contain the four incident families, ordinary and
   incomplete controls, and the frozen manual planning artifact. The manual
   artifact has an independent 5/5 semantic assessment and explicit missing
   structural traceability.
2. FAIL [read]: The failed/incomplete-usage case lacks accepted joined
   provenance as described above. Other five historical cases cite bounded
   handoff records and state that pre-repair revisions/runtime effects are
   unknown.
3. PASS [read/ran]: Current raw digests match corpus, observations, baseline,
   checker, CLI, and metric definitions; the CLI validates pinned source and
   artifact bytes and replays the current captured manifest.
4. PASS for declared offline scope [read/ran]: CLI reports 4 pass, 2 fail, 1
   inconclusive, planning semantic score 5/5, accepted results null, first-pass
   ratio null, measured cost null. No live behavior or model/workflow savings
   are established.
5. PASS for reviewer coverage [read]: Integrated verifier approved the current
   checker and baseline replay. This audit supplies an independent evidence
   review, but its criterion-2 failure prevents baseline_ready acceptance.
6. UNVERIFIED [read]: The lead has not yet recorded a final durable handoff and
   accepted baseline decision. Empty manifest review references and
   `eligibility.ready=false` are correct for captured status.

## Exact target and checks

- Baseline fd255588d184b97b7c07e1e7d9ce8cd464dfda501c3d560fc1b055873a2b992c.
- Corpus ee4becac07508507ed601cf016e21416135dcec413ae0c568ddafaf502e8b98b.
- Observations 5b055df47bf60162f3da66360cd27057635fceb043d7e08fd85ed07d69163a0e.
- Evaluator 829ad5dc365404712a9382964ffd5dc91387a1eb2d1d35785919c62438982f25.
- CLI ea73d34140f9932ebef0cf692c53efa7e3ee8d69caf02916c23d4d49bcb7e05e.
- Metric definitions 55ab34120292726741263bfba9e8498f8db09304a5510caec446d0311ef4c8ed.
- Ran `node tools/autonomy/evaluate.js --root . --corpus test/fixtures/autonomy/corpus-v2/corpus.json --observations test/fixtures/autonomy/corpus-v2/observations.json --baseline test/fixtures/autonomy/corpus-v2/baseline.json --json`: exit 0, valid=true, assessed=true, ready=false, seven cases and observations.
- Read `git diff` and current untracked files. The tracked lead-graph test diff
  adds verifier dispatches and strengthens a send-count assertion; it does not
  weaken verification. A05-R01 through A05-R08 are addressed structurally in
  the current checker/capture, subject to the provenance failure above.

The accepted comparison scope can only cover frozen artifact structure and
offline checker behavior. Historical summaries do not prove live target
behavior, and the manual planning artifact does not establish current harness
or model workflow performance. A fresh baseline capture is needed after any
source observation correction. No reviewed source, test, fixture, or config
was edited in this audit.

## Supplemental read-only source check before v3 review

After the rejection, the worker identified a concrete historical case. I
independently read only the selected task rows in
`.runtime/projects/c8740b5b4f/state.sqlite` and `performance.sqlite`, plus
the matching launcher metrics JSON. Task
`e88656f4-3880-43ce-aa6a-c39b88fa7eeb` has `TASK_STATE_FAILED`.
`dispatch_journal` joins it to assignment
`a125b4c6-f640-45ae-a106-22f97837f8e9:r33:a0` and attempt suffix `:t1`.
The same task's `usage_ledger` row has `token_source=unavailable`,
`tokens_json=NULL`, `outcome=failed`, `elapsed_ms=5573`, `turns=1`.
`performance_attempts` joins the same task and assignment with failed state,
all token columns NULL, and 5573 elapsed ms. The launcher metrics snapshot has
the same task and assignment with failed state and null tokens. This establishes
a suitable source join for a newly captured v3 observation if its sanitized
export preserves and pins those identities. The v2 rejection remains in force;
the v3 target has not yet been reviewed.
