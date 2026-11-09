# AUT-01 analyzer API

`src/spec-analyzer.js` is a read-only CommonJS module for the P1.2 structural
checkpoint. It reuses `validateTraceability` from `src/spec-context.js` for
context/map references, coverage, bindings, scope, risk, checks, and decisions.
It does not accept contexts, compile assignments, or establish final feature
readiness.

## Entry point

`analyzeTaskMap({ workspaceRoot, contextResult, expectedContextSha256, map })`
expects a context result from `loadContext` and a parsed map from the caller's
trusted map loader. It repeats traceability validation and verifies the bound
`tasks.md` bytes before parsing the projection.

The result has:

- `ok`: structural context/map, graph, and projection checks pass. This is not
  final readiness because assignment contract validation is pending.
- `findings`: deterministic `{ code, path, message, taskIds }` records sorted by
  code, affected IDs, path, and message. At the 1000 finding limit, an explicit
  `finding_limit_exceeded` record marks the analysis incomplete.
- `mapValidation`: the reused traceability result summary.
- `graph`: deterministic task order, cycle groups with one stable witness per
  group, and conflicts between parallel-marked tasks.
- `projection`: checklist task IDs and checkbox states, plus any missing,
  unknown, duplicate, outside-block, marker, fence, comment, or `[P]` mismatch
  findings.
- `assignmentValidation`: always `pending` in this milestone.

## Projection rules

Exactly one ordered begin/end marker pair defines the authoritative block.
Checklist rows in that block must match the map task ID inventory, have
nonempty text, and match each task's `parallel` value through `[P]`. Checklist
rows outside the block are rejected. Fenced code and HTML comments are skipped;
malformed or unclosed fences/comments and malformed task-map markers are
reported rather than used to hide rows.

Graph edges come only from `dependsOn`. Valid DAGs use task-ID tie breaking in
topological order. Cycles return sorted strongly connected groups and a stable
cycle witness. Parallel conflicts include transitive dependency pairs and
overlapping file/directory write scopes. No scheduler wave is inferred.
