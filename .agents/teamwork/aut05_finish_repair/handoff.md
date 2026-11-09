# AUT-05 v3 evidence repair handoff

## Result

Created corpus v3 (corpus ID `aut-05-regression-corpus-v3`, revision 4; baseline ID `aut-05-baseline-offline-v3`). V2 was left byte-for-byte unchanged at baseline fd255588d184b97b7c07e1e7d9ce8cd464dfda501c3d560fc1b055873a2b992c; v1 fixtures were also unchanged. The v3 baseline has six applicable limitations covering offline measurement boundaries, five handoff-only historical cases, manual planning provenance, semantic-only score scope, unavailable live metrics, and the joined attempt limits. The failed-usage case now joins one concrete r33 auditor task/assignment/dispatch attempt to its failed task state, usage ledger row, and performance projection. It remains inconclusive; counts did not change.

Sanitized evidence is `test/fixtures/autonomy/corpus-v3/failed-incomplete-usage-evidence.json`. It records run `a125b4c6-f640-45ae-a106-22f97837f8e9`, assignment `...:r33:a0`, task `e88656f4-3880-43ce-aa6a-c39b88fa7eeb`, and attempt `...:r33:a0:t1`. The task is failed (`serverOverloaded`, `audit_execution_failed`); its usage row says token source unavailable, tokens null, one turn, 5573 ms. The metric projection matches the run/assignment/task with all token fields null. Elapsed time remains unavailable because 5573 ms covers one failed attempt, not a full case/workflow interval. No review verdict, measured spend, or target source revision is inferred.

The export used one `query_only` read transaction with state and performance SQLite databases attached. Main database and WAL file hashes were checked before and after; all source files were unchanged. State DB uses WAL mode and its WAL was present but empty. No source DB or service was modified.

## Verification

- `node --test --test-isolation=none test/autonomy-evaluation.test.js test/autonomy-evaluation-cli.test.js test/autonomy-schemas.test.js` - 49 pass, 0 fail.
- `node tools/autonomy/evaluate.js --root . --corpus test/fixtures/autonomy/corpus-v3/corpus.json --observations test/fixtures/autonomy/corpus-v3/observations.json --baseline test/fixtures/autonomy/corpus-v3/baseline.json --json` - exit 0; valid=true, assessed=true, ready=false; 7 cases/observations; 4 pass, 2 fail, 1 inconclusive; requirement preservation 5/5; acceptedResults=null.
- V3 baseline pins: 14 checked, 0 mismatches.
- `git diff --check` and JS syntax checks for the three changed autonomy test files - pass.

## Final digests

- V3 corpus: `bf180584c4ee3620b2c676f42e0c09be8d977dec2d82cbd39e3fd90cf60485fc`
- V3 observations: `99b50d7b5c2983ca3d380507120d08ac3caf4965ab3daede3832d263fe24defa`
- V3 baseline: `4fe46b3cc7d7a67e5bc1df2c5347f5bcd007fccb808a8294671d0a0ee0183786`
- Sanitized failed-usage evidence: `24a1f47bc94051775ebb988a3d56a56581c8de56a176348f818a084f1d834c88`
- V3 historical source evidence: `01b51661485c7a4bbe1bc650f7df58bef7471eaf283134a052d90ae5ea17c260`
- Source state main / WAL: `958065171649cf4826069eda8e171b77e4222590b6ccd85e6ebb21c7c19a2f42` / `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- Performance DB / metrics snapshot: `5d6cc9040ab8549a5ae697429273402e9700c86c919c6f1d31083e94b1064154` / `99a2e97e9f04d75147cd30a7af0e133af763ef255d481a7adb8079d688a49409`

Changed files are limited to `test/autonomy-evaluation.test.js`, `test/autonomy-evaluation-cli.test.js`, `test/autonomy-schemas.test.js`, and new `test/fixtures/autonomy/corpus-v3/**`. Lead owns independent review and Git.

Status: complete
Scope expansion: none
