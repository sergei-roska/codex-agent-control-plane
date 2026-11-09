# Spec context API proposal

## Module

`src/spec-context.js` is a CommonJS, read-only module. It does not execute
checks, mutate files, infer risk from prose, or establish that a context is
complete. The caller supplies the workspace root and accepted context digest.

## Exports

- `loadContext({ workspaceRoot, contextPath, expectedSha256 })` reads bounded
  JSON bytes below the trusted root, verifies their digest against the caller's
  digest, then checks source digests, source spans, inventory references,
  decisions, paths, risk rules, and verifier check scopes. It returns
  `{ ok, errors, context, contextSha256, sources }`.
- `validateContext(context, { workspaceRoot })` validates an already parsed
  value and the pinned source files. It is useful for focused tests. It does
  not establish a trusted context digest; use `loadContext` at an input
  boundary.
- `loadTraceability({ workspaceRoot, mapPath, contextResult,
  expectedContextSha256 })` reads and hashes the map bytes, checks the caller's
  context digest binding, hashes the spec/plan/tasks bindings, then validates
  task references, coverage, write scope, checks, review risk, and unresolved
  decisions. It returns `{ ok, errors, map, mapSha256 }`.
- `validateTraceability(map, { workspaceRoot, contextResult,
  expectedContextSha256 })` performs the same semantic checks for a parsed map;
  `loadTraceability` is required to verify map bytes.
- `isSafeRelativePath`, `inspectWorkspacePath`, `splitSourceLines`,
  `extractSourceLocation`, and `deriveReviewKind` expose bounded primitives for
  later analyzer work.

All validation functions return structured findings and cap findings at 200.
Context and map JSON are limited to 1 MiB each, sources and artifacts to 4 MiB
each, and context source bytes to 32 MiB total. The later analyzer must enforce
the parent-plan 32 MiB aggregate budget across JSON, sources, and artifacts.
Input JSON and sources are UTF-8 and bounded. Source line numbers are
one-based, inclusive, and accept LF or CRLF. Bare CR is rejected. Paths are
workspace-relative, reject traversal and platform-absolute forms, and inspect
existing ancestors for symlink escapes and non-directory components. Any
symlink component in an allow/deny, risk, verifier, or proposed write scope is
rejected, including an in-root alias, so a lexical path cannot bypass scope
policy. Read source symlinks may resolve only within the trusted root.

## Semantic boundary

The JSON Schemas define strict nested data shapes. Runtime validation adds
filesystem, digest, reference, scope, and cross-record checks that JSON Schema
cannot express. Hashes establish byte identity only. Independent review must
establish that the inventory is complete and that source spans and risk
classifications agree with canonical meaning. The candidate fixture is not
accepted context; the lead-owned `context/accepted-context.json` will supply
the accepted digest after independent review.
