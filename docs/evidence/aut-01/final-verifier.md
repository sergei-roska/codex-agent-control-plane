# AUT-01 integrated P1.5 technical review

Verdict: APPROVE for the frozen offline analyzer/adapter/CLI checkpoint. Status: complete. Scope expansion: none.

## Frozen target

- src/spec-analyzer.js: 1cd0a87793ac61d891145d9c7b905438ecb6ac89de2210b70bb940f94802912c
- src/spec-assignment-adapter.js: 723600b0a5b76e03d44a8dbbd26d5f38325d17e36a3f6050808cd8475225c585
- tools/spec-kit/analyze.js: cdbe9c58f70ebc0d776e9a17f8a663392e83b8f5ef58979f6451ace86763e399
- test/spec-analyzer-cli.test.js: b1e4acf255f3482e7c07d7165809cb98778b993b426bcdbc567f1362afd4da89
- test/spec-assignment-adapter.test.js: aa09ec132c9bdc24ecb363fd0307f4c35e6bcfeb178a3074dc16af50215b80e5
- Reused context and analyzer test hashes: 8529da89cb0860d88fce6af17e618405d53970cd3580fa9942ce9ecadb4de48d and 3931a9959aa992e50533dbdc2cf15a3dee5469c25943f25549c0b4da848c682f.

## Independent checks

- Ran `node --test --test-isolation=none --test-reporter=tap test/spec-context.test.js test/spec-analyzer.test.js test/spec-assignment-adapter.test.js test/spec-analyzer-cli.test.js`: 38 pass, 0 fail, 0 skip.
- Ran explicit accepted F2 CLI with workspace `test/fixtures/spec-kit/pilot-price`, context `context/pilot-context.json`, accepted SHA `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`, map `specs/pilot-price/traceability.json`, project `profiles`, and `--json`: exit 0, pass, no findings, 4 mandatory requirements and AC-1 covered, 2 contract-valid proposals, `implementationAcceptance: not_evaluated`, fingerprint `2f6accab6c0342b50bb61701555621bc51105cffdbf17be500028b284e015e25`, 240351 captured bytes.
- Read source and tests: all workspace/source/artifact/checker/contract/profile/TEAM bytes enter the manifest; 32 MiB aggregate budget is enforced during first reads; observed inputs are reread for drift. Explicit `--profiles` reaches `loadRoles`, and callback compares loaded text with captured profile bytes. Report paths are relative and absolute roots are redacted from findings. CLI performs no planned check or write.
- Ran `node /tmp/aut01-final-probes.js` against disposable fixture copies. Q21 missing objective, missing review reason, empty stops, absent verifier paths, outside verifier paths all returned blocked (exit 1). Q23 21 stop conditions returned blocked. Q25 boolean `timeoutMs` returned blocked. Q24 input deleted before drift reread returned blocked with `input_drift_detected`; fingerprint remained present but verdict was unusable for passing. Exact output was observed in this review; `/tmp/aut01-final-probes.js` is scratch evidence and may disappear.
- Existing tests give actual controls for the remaining Q01-Q28 families as mapped in `.agents/teamwork/aut01-cli/qualification.md`. The mapping alone does not assert every subvariant: the independent scratch probes above close the specifically missing Q21, Q23, Q24, and Q25 variants. Q21 unknown role is exercised by the profile override test. Additional scratch probes returned blocked for Q05 duplicate requirement/criterion/check/evidence IDs, Q07 parent traversal/absolute/glob/empty-segment paths, Q18 changed spec/plan/tasks bytes, and Q20 injected root/scope/context authority fields.
- Inspected `git status --short` and `git diff --stat`: AUT01 files are untracked, so Git has no tracked diff for them. Reviewed the actual files and exact hashes. No source, tests, fixtures, or Git state changed in this review.

## Limits

- This is offline structural and contract validation. It does not prove task prose matches canonical intent, execute product checks, prove implementation acceptance, or admit a live dispatch. The report states those limits.
- Snapshot reread detects observed drift but is not an atomic filesystem snapshot under concurrent writers.
- Root owns the full repository suite and final milestone acceptance. No service, model, live DB, or product test ran here.
