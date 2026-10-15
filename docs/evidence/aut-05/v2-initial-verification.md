# AUT-05 acceptance review

Correction after delta re-review: This document records the rejected earlier
baseline digest 0a499388... and is superseded by final.md for current baseline
fd255588.... Blocking finding 2 below was incorrect. The pure evaluator receives
parsed observations and trusted local artifact metadata, not the raw observation
file bytes. The line-172 mutation does not alter a claimed artifact digest;
its prior failure was caused by stale checker pins. The original unmodified test
passes after the pin repair. This correction retains the original review history
without treating that mistaken mechanism as a current defect.

Verdict: REJECT
Status: partial
Scope expansion: none

## Current reviewed target

Read Git status and diff, the AUT-05 runbook/review/metric definitions, current
source, CLI, tests, schemas, v2 fixtures, planning capture, and historical notes.
All AUT-05 implementation files are untracked. The tracked lead-graph test diff
adds fresh verifier dispatches before retry auditors and strengthens the send
count from 5 to 8; no assertion weakening was found there.

Current raw SHA-256: corpus ee4becac07508507ed601cf016e21416135dcec413ae0c568ddafaf502e8b98b;
observations 5b055df47bf60162f3da66360cd27057635fceb043d7e08fd85ed07d69163a0e;
baseline 0a4993887897a3069c4171e96f6628c99f0f9c51b8b791681060f0d2f2a5c5e0;
evaluator 829ad5dc365404712a9382964ffd5dc91387a1eb2d1d35785919c62438982f25;
CLI ea73d34140f9932ebef0cf692c53efa7e3ee8d69caf02916c23d4d49bcb7e05e.
The baseline pins earlier evaluator 6edba5a46a0d8d336dd2fd21a8073a2edc12362a48ff23d443ba6468757a1cea
and CLI fcd3a5cd65db59aa743b8923bbaaed64e609f25e33a1b4f9f22996eff2797950.
Prior worker handoff digests are superseded.

## Blocking findings

1. `test/fixtures/autonomy/corpus-v2/baseline.json:78` [ran/read]: The frozen
   baseline pins stale checker bytes. `node tools/autonomy/evaluate.js --root .
   --corpus test/fixtures/autonomy/corpus-v2/corpus.json --observations
   test/fixtures/autonomy/corpus-v2/observations.json --baseline
   test/fixtures/autonomy/corpus-v2/baseline.json --json` exits 3 before
   evaluation: `baseline pin for src/autonomy-evaluation.js does not match the
   currently executing checker bytes`. The CLI checks the executing source in
   `tools/autonomy/evaluate.js:185-193`, so the captured candidate cannot be
   replayed or accepted. Freeze the finished checker and regenerate v2 source
   pins and baseline digest; rerun the CLI and focused suite on unchanged bytes.
2. `test/autonomy-evaluation.test.js:172` [ran/read]: The test changes a frozen
   observation's `dataOrigin` in memory and expects `report.valid === true`
   while retaining the original baseline observation pin. The evaluator checks
   `baseline.sourceOutputDigests` through `verifyArtifactClaims` at
   `src/autonomy-evaluation.js:1025-1060`, so this assertion contradicts the
   required immutable-byte binding. The focused run fails here even after other
   tests continue. Keep digest verification; use a consistent repinned
   illustrative test baseline or assert invalid input, while still checking
   that acceptedResults remains null.

## Acceptance criteria status

- Corpus families, controls, planning capture: PASS [read]. Seven v2 cases cover
  four named families, ordinary and incomplete controls, and the manual AUT-01
  artifact. The capture is explicitly manual, with independent semantic review
  and source digests; no model or harness execution is claimed.
- Case provenance and measured metric boundaries: PASS for the declared offline
  scope [read]. Historical observations state unknown pre-repair revisions and
  no runtime effects. Planning semantic score is 5/5; traceability is separately
  absent. Accepted results, live timing, tokens, and measured cost remain null.
- Exact frozen source and replay: FAIL [ran]. Current source pins mismatch.
- Independent verifier/auditor of integrated candidate: UNVERIFIED. This review
  rejects current bytes; empty manifest review refs are appropriate for captured
  status, with a separate lead decision required after reviews.
- Durable baseline_ready handoff: UNVERIFIED. Lead has not recorded one for v2.

## Decisive checks

- Node v24.21.0.
- Focused leaf run: `node --test --test-isolation=none --test-reporter=tap
  test/autonomy-evaluation.test.js test/autonomy-evaluation-cli.test.js
  test/autonomy-schemas.test.js`: 49 tests, 44 pass, 5 fail. Three CLI failures
  stop on stale checker pins; the positive pure report and the line-172 mutation
  test fail on invalid digest claims.
- Direct v2 CLI command above: exit 3, stale evaluator pin.
- `git diff --check`: pass.
- Planning source/capture/reviewer raw hashes were checked and match current
  v2 references. The independent planning assessment is limited to artifact
  semantics, not implementation quality or live-model performance.

Pitfall: Updating frozen observation or evaluator bytes without regenerating the
exact baseline pins makes positive controls fail before they can test behavior.
