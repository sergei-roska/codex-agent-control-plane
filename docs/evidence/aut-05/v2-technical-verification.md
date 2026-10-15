# AUT-05 corrected candidate final verification

Verdict: INCONCLUSIVE
Status: partial
Scope expansion: none

The independent verifier checkpoint is APPROVED. Overall `baseline_ready`
acceptance remains INCONCLUSIVE until the required auditor evidence and durable
lead handoff exist. This distinction follows the runbook's section 10 readiness
criteria; it is not a defect in the current evaluator or captured baseline.

## Target identity

Current corpus-v2 raw SHA-256: corpus
ee4becac07508507ed601cf016e21416135dcec413ae0c568ddafaf502e8b98b;
observations 5b055df47bf60162f3da66360cd27057635fceb043d7e08fd85ed07d69163a0e;
baseline fd255588d184b97b7c07e1e7d9ce8cd464dfda501c3d560fc1b055873a2b992c.
Evaluator 829ad5dc365404712a9382964ffd5dc91387a1eb2d1d35785919c62438982f25;
CLI ea73d34140f9932ebef0cf692c53efa7e3ee8d69caf02916c23d4d49bcb7e05e;
metric definitions 55ab34120292726741263bfba9e8498f8db09304a5510caec446d0311ef4c8ed.
The new baseline pins current evaluator, CLI, corpus, and observation bytes.
No implementation or test source changed in this delta.

## Criteria against docs/aut-05-baseline-runbook.md section 10

1. PASS [read]: Seven v2 cases include all four named incident families,
   ordinary/incomplete controls, and the frozen manual AUT-01 planning artifact.
   The latter has independently reviewed semantic inventory and explicit
   structural traceability limitation.
2. PASS [read/ran]: Each case has an observation joined to the declared mode.
   Six target cases are labeled historical with bounded handoff provenance;
   pre-repair source revisions and runtime effects are explicitly unknown.
   CLI validates all seven references with no error findings.
3. PASS [ran]: Source, CLI, schemas, metric definitions, corpus, observations,
   planning artifacts, and reviewed assessment are pinned by raw digest.
   Current CLI replays the captured baseline successfully.
4. PASS [ran/read]: CLI reports 4 pass, 2 fail, 1 inconclusive; planning semantic
   score 5/5. `acceptedResults`, first-pass checkpoint ratio, time, tokens, and
   measured cost remain null. No live-model or workflow-improvement claim follows.
5. PASS for independent verifier coverage [ran/read]; auditor evidence is still
   a lead coordination obligation before a separate `baseline_ready` decision.
   The captured manifest correctly has empty review refs and `ready=false`.
6. UNVERIFIED for final lead handoff, which is not part of the implementation
   candidate under this verifier review. The lead must record accepted artifact
   digest and durable evidence location before AUT-01 entry.

## Decisive checks

- `node tools/autonomy/evaluate.js --root . --corpus
  test/fixtures/autonomy/corpus-v2/corpus.json --observations
  test/fixtures/autonomy/corpus-v2/observations.json --baseline
  test/fixtures/autonomy/corpus-v2/baseline.json --json`: exit 0; `valid=true`,
  `assessed=true`, `ready=false`, seven cases/observations, 4/2/1 outcomes,
  requirement preservation 5/5, accepted results null.
- `node --test --test-isolation=none --test-reporter=tap
  test/autonomy-evaluation.test.js test/autonomy-evaluation-cli.test.js
  test/autonomy-schemas.test.js`: 49 tests, 49 pass, 0 fail.
- Targeted changed lead-graph cases via `--test-name-pattern`: 2 pass, 0 fail.
  The tracked test diff adds fresh verifier dispatches and strengthens send
  count from 5 to 8; it does not weaken assertions.
- `node --check` on evaluator and CLI: pass. `git diff --check`: pass.

## Correction and limits

The earlier line-172 test finding was incorrect. The pure API gets parsed
observations and verified artifact metadata; it has no raw observation input
bytes to pin. Raw corpus/observation file binding is enforced by the CLI.
After only baseline pin changes, the original line-172 test passes. The initial
review remains in handoff.md with an explicit correction.

The verifier approval covers the reproducible offline evaluation implementation
and captured evidence only. It is not a live-model benchmark or project-level
`baseline_ready` grant. The lead still owns auditor review, durable acceptance
record, and AUT-01 handoff.
