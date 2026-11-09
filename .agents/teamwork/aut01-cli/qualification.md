# AUT-01 Q01-Q28 qualification mapping

## Exact focused verification

`node --check src/spec-analyzer.js && node --check src/spec-assignment-adapter.js && node --check tools/spec-kit/analyze.js && node --check test/spec-analyzer-cli.test.js && node --check test/spec-assignment-adapter.test.js && node --test --test-isolation=none test/spec-context.test.js test/spec-analyzer.test.js test/spec-assignment-adapter.test.js test/spec-analyzer-cli.test.js`

The final run result is recorded in `handoff.md`. No planned product check,
model, service, full repository suite, or live dispatch is part of this command.

| Case | Exercised control |
|---|---|
| Q01-Q05 | `test/spec-analyzer.test.js`: `base map findings cover requirement, acceptance, evidence, check, and decision defects`; duplicate task ID control. Context duplicate IDs are included in `test/spec-context.test.js`: `nested shape, references, and source line bounds fail closed`. |
| Q06 | `test/spec-analyzer.test.js`: `DAG order is stable, cycle witnesses are stable, and dangling edges block graph analysis`. |
| Q07-Q09 | `test/spec-context.test.js`: `schemas are strict nested contracts and bound safe relative paths`; `write scopes, review risk, and task bindings are cross-validated`. |
| Q10 | `test/spec-context.test.js`: `unsafe paths and symlinked ancestors are rejected`; `write scopes reject in-root symlinks at file and ancestor paths`. CLI context symlink alias is also rejected. |
| Q11 | `test/spec-analyzer.test.js`: `parallel conflicts include transitive dependencies and parent-child writes`. |
| Q12-Q16 | `test/spec-analyzer.test.js`: base map findings test plus `test/spec-context.test.js`: cross-validation of review risk and scopes. |
| Q17 | `test/spec-context.test.js`: `caller digest and canonical source bytes are both required`; CLI source digest mismatch control in `test/spec-analyzer-cli.test.js`: `changed source and artifact membership are rejected against captured digests`. |
| Q18 | CLI artifact digest mismatch test and analyzer bound artifact digest control. |
| Q19 | `test/spec-analyzer.test.js`: `projection requires exact inventory, markers, and parallel annotations`; `Markdown scanner ignores fenced/comment examples but rejects malformed hiding constructs`. |
| Q20 | CLI unknown `contextPath` authority field test; caller digest mismatch and strict map/context shape controls. |
| Q21 | `test/spec-assignment-adapter.test.js`: `oversized assignment objectives block every role proposal`; accepted F2 checks both contract validators. |
| Q22 | `test/spec-assignment-adapter.test.js`: `every task is compiled and a bad task does not hide a valid sibling`. |
| Q23 | `test/spec-assignment-adapter.test.js`: `oversized source excerpts and malformed checks block without truncation`; contract array/objective bounds are also checked. |
| Q24 | `test/spec-analyzer-cli.test.js`: `input drift during analysis blocks the snapshot report`, with a controlled source mutation before final drift reread. |
| Q25 | CLI invalid JSON and unsupported context/map version controls; context malformed collections and nested shape controls. |
| Q26 | CLI context-size and aggregate 32 MiB budget controls; context source per-file and source-total bounds. |
| Q27 | Synthetic unresolved decision in `test/spec-analyzer.test.js`: base map findings test. |
| Q28 | CLI complete pass report and semantic-control test assert `implementationAcceptance: not_evaluated`; adapter proposals are plans, not receipts. |

## Positive and no-write controls

- Accepted F2 report passes, includes all four mandatory requirements and AC-1,
  validates every assignment, pins source/artifact/checker/profile bytes, and
  produces byte-identical JSON on repeat invocation.
- The profile override test changes an engineer role name; this changes both
  role validation and the fingerprint.
- The no-write test inventories every workspace path, file byte digest, mode,
  and symlink target before and after analysis. A sentinel-writing command is
  present only as planned `argv`; no sentinel is created.
- The semantic-control test changes an objective while retaining IDs. The
  structural result can pass and explicitly states that semantic agreement is
  not machine-proved.

This mapping records controls exercised by named assertions. It does not claim
the report proves arbitrary prose consistency, live admission, check execution,
or implementation acceptance.
