# AUT-01 P1.2 analyzer technical review

Verdict: APPROVE
Status: complete
Scope expansion: none

Reviewed frozen `src/spec-analyzer.js` SHA-256
`eb1e6ee1f9f68b0bb589e18d83b50d3a3b78c0a31710b1ab3a3aa2c4959816dc`
and `test/spec-analyzer.test.js` SHA-256
`3931a9959aa992e50533dbdc2cf15a3dee5469c25943f25549c0b4da848c682f`.
P1.1 source/context/schema/fixture approvals were reused; no adapter, CLI, or
final feature readiness is asserted.

PASS [read/ran]: `analyzeTaskMap` reuses strict map validation and rechecks
the pinned `tasks.md` bytes before projection. `dependsOn` is the sole graph
input. Invalid IDs/references skip dependent graph analysis. DAG order breaks
ties by task ID; strongly connected cycle groups and witness paths are stable.
Parallel-marked tasks are checked for transitive dependency and typed file/
directory write overlap. An independent two-cycle probe returned sorted
T001/T002 and T003/T004 witnesses.

PASS [read/ran]: Projection requires one ordered marker pair, exact task ID
inventory, nonempty rows, and `[P]` parity. It scans real checklist rows outside
the block while excluding fenced/commented examples; malformed or unclosed
fences/comments produce findings. An independent projection probe ignored a
fenced T999 example and rejected a real T002 row outside the block.

PASS [read/ran]: P1.1 reference, mandatory coverage, planned check,
prior-evidence, scope, risk, and unresolved-decision validation is reused.
Malformed map input returns findings, with an explicit sentinel at the finding
bound. `assignmentValidation` remains `pending`, and analyzer `ok` is limited
to structural validation. No model, shell command, product check, or writer is
invoked by this module.

Additional malformed-nested probe [ran]: while graph/projection continued
after base validation errors, parallel tasks with null `writePaths` members,
null path values, and a null task member each returned `ok=false` with
structured findings; none threw. `validGraphTasks` guards task IDs and
dependencies, and `pathsOverlap` guards both path operands before string use.

`node --test --test-isolation=none test/spec-context.test.js
test/spec-analyzer.test.js`: 20 pass, 0 fail. Source inspection found no
blocking P1.2 defect in the reviewed graph/projection paths. No reviewed source,
tests, fixtures, or Git state were changed by this review.
