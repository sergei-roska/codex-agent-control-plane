# AUT-05 v3 delta review

## Post-review metadata correction: b986 candidate

Verdict: REJECT for frozen baseline digest
`b98685576dc56408ae459260aafb4199de2539bba8cd338ee4e7b84657e7dfbb`.
At `test/fixtures/autonomy/corpus-v3/baseline.json:118-120`, the claimed
one-string wording correction instead replaced the previous six-item
limitations array with a single historical-count sentence. This removes the
manifest-local offline/no-model/token/cost boundary, manual planning provenance,
5/5 semantic-only boundary, unavailable accepted/live metrics, and joined
attempt duration limit. The broader input set and CLI retain several of these
facts, and the CLI still exits 0, but the captured baseline's required
limitations are materially incomplete for an immutable reference. Restore the
five applicable entries, correct the historical count to five, and regenerate
the baseline digest. This post-review verdict supersedes the APPROVE below for
the b986 candidate; that prior verdict applies only to d14feb07... bytes.

The current corpus bf180584..., observations 99b50d7b..., export 24a1f47b...,
evaluator 829ad5dc..., and CLI ea73d341... hashes are unchanged. Direct v3
CLI replay on b986 still exits 0 with valid/assessed true and ready false;
the failure is semantic manifest retention, not parser behavior.

Verdict: APPROVE
Status: complete
Scope expansion: none

## Target and delta

Review mode: technical review of the corrected v3 fixture delta, not the lead's
separate `baseline_ready` acceptance decision. The evaluator, CLI, schemas,
metric definitions, and frozen planning artifact are unchanged from the prior
verifier checkpoint. v1 and v2 JSON hashes remain unchanged. New v3 evidence
adds a joined failed auditor attempt with unavailable token data and a pinned
historical export. The tests switch their positive fixture to v3 and retain the
existing negative assertions.

Raw SHA-256: v3 corpus
bf180584c4ee3620b2c676f42e0c09be8d977dec2d82cbd39e3fd90cf60485fc;
observations 99b50d7b5c2983ca3d380507120d08ac3caf4965ab3daede3832d263fe24defa;
baseline d14feb07f4bd0944dc84a093647ffff3414e4fa16f0971ddcfc0ae9d7a0de5a4;
failed usage export 24a1f47bc94051775ebb988a3d56a56581c8de56a176348f818a084f1d834c88;
historical notes 01b51661485c7a4bbe1bc650f7df58bef7471eaf283134a052d90ae5ea17c260.
Evaluator 829ad5dc365404712a9382964ffd5dc91387a1eb2d1d35785919c62438982f25;
CLI ea73d34140f9932ebef0cf692c53efa7e3ee8d69caf02916c23d4d49bcb7e05e.

## Evidence assessment

PASS [read]: The v3 case and observation bind the same run, task, assignment,
attempt, and source snapshot. The observation's evidence digest matches the
export, and the baseline pins corpus, observation, export, and current checker
bytes. The export records `TASK_STATE_FAILED`, `serverOverloaded`,
`audit_execution_failed`, `tokenSource=unavailable`, null token fields, and a
single failed attempt duration of 5573 ms. The observation remains
`inconclusive`, with null token, cost, and complete elapsed-time metrics. It
does not claim a review verdict or accepted result. The separate auditor's
read-only source inspection confirmed the task/dispatch/usage/performance join;
this review reused that source-level evidence and independently checked the
captured artifact relationships.

PASS [ran]: `node tools/autonomy/evaluate.js --root . --corpus
test/fixtures/autonomy/corpus-v3/corpus.json --observations
test/fixtures/autonomy/corpus-v3/observations.json --baseline
test/fixtures/autonomy/corpus-v3/baseline.json --json` exits 0; `valid=true`,
`assessed=true`, `ready=false`, seven cases and observations, 4 pass, 2 fail,
1 inconclusive, planning score 5/5, accepted results null.

PASS [ran]: `node --test --test-isolation=none --test-reporter=tap
test/autonomy-evaluation.test.js test/autonomy-evaluation-cli.test.js
test/autonomy-schemas.test.js` yields 49 pass, 0 fail. `git diff --check` passes.

Non-blocking: The export's target implementation revision, complete workflow
interval, and measured subscription spend remain unknown and are explicitly
declared as such. Technical approval does not establish live-model performance
or grant the lead's separate baseline readiness decision.
