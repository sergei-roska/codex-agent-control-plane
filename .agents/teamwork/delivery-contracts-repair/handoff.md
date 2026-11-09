# CN-01 repair handoff

Status: complete.

## Before-edit evidence and hypothesis

Before edits, `node .agents/teamwork/delivery-contracts-challenge/probe.cjs`
reproduced accepted queued replacements that introduced supersession references
to active or missing tasks, TypeErrors for object/string checkpoints, and Ajv
accepting `src//x` while the JS validator returned `path_unsafe`. Inspection
showed reference checks only in the new-task route, unchecked checkpoint
iteration, and a schema path regex without empty-segment exclusions. Initial
hypothesis: narrow route/container/schema guards would repair the mismatch
without changing standalone trusted-record semantics or legacy schemas.

The challenger also reproduced accepted standalone edges with missing
successors and duplicates to missing successors. The lead confirmed this is in
scope and asked for an explicit successor check against the complete resulting
task map, duplicate rejection, and clear inline/standalone overlap semantics.

## Changes

- Revisioned replacements require prior supersession lineage to remain unchanged;
  they cannot introduce, alter, or remove `supersedesTaskId`. New-task
  supersession retains its existence, mutability, and CAS checks.
- Checkpoint containers must be arrays in dependency graph validation and plan
  projections; errors use `checkpoints_array_required` and stable paths.
- Safe-path schema pattern now rejects repeated and trailing slashes, matching
  the JS relative-path segment rule.
- Standalone dependencies require a successor in the complete resulting task
  map. Duplicate tuples within the delta fail with `dependency_duplicate`;
  existing edge replacement remains allowed only when its existing successor
  has a revisioned task replacement. Inline/standalone overlap for that
  revisioned successor intentionally replaces the matching tuple. Tuple keys
  use JSON encoding to avoid delimiter collisions in valid IDs.
- Trusted settled task validation and legacy schemas were not changed.

`validatePlanDelta` returns normalized proposed task records (without each
input wrapper's `expectedRevision`) plus standalone dependency records. It does
not return the fully materialized next projection; the storage caller must still
project supersession state and merged edge updates.

## Verification

- `node --test test/delivery-contracts.test.js`: 16 passed, 0 failed. Includes
  route/reason regressions, trusted settled records, Ajv safe-path agreement,
  standalone edge behavior, and colon-containing ID collision coverage.
- `node .agents/teamwork/delivery-contracts-challenge/probe.cjs`: exit 0; all
  contract attack cases reject. Its schema case reports `value.valid: false`
  inside the probe's successful result wrapper.
- `node --check src/delivery-contracts.js`: passed.
- JSON parse of `schemas/delivery-v1.schema.json`: passed.
- ASCII, final-newline, and trailing-whitespace scan on all three owned product
  files: passed.
- `git diff --no-index --check /dev/null <owned-file>` for each owned product
  file: no diagnostics; exit 1 is expected because each file is untracked in
  this baseline. No Git state was changed.

No full suite was run. Changed product files are only
`src/delivery-contracts.js`, `schemas/delivery-v1.schema.json`, and
`test/delivery-contracts.test.js`; handoff artifacts are confined to this
teamwork directory. No live services/state/provider/target actions occurred.

## Critic re-review correction

The critic identified that general `string()` permits tab, LF, and CR, so the
first path agreement test set was incomplete. `safeRelativePath` now explicitly
rejects all C0 and DEL characters as `path_unsafe` before the general string
check. The broader JSON validator already rejects NUL, other C0 characters, and
DEL as `json_string_invalid`; that policy is unchanged. General prose strings
retain their existing policy.

The paired Ajv/JS regression now compares a valid relative path and 13 unsafe
forms (tab, LF, CR, NUL, another C0 control, DEL, absolute, drive-prefixed,
backslash, dot segment, parent segment, repeated slash, trailing slash) across
`productWritePaths`, known `readScope.paths`, and `scratchWriteRoots`.

Re-verification after the correction:
- `node --test test/delivery-contracts.test.js`: 16 passed, 0 failed.
- `node .agents/teamwork/delivery-contracts-challenge/probe.cjs`: exit 0; attack
  cases reject, and its added positive lineage/colon-ID cases accept.
- `node --check src/delivery-contracts.js` and schema JSON parse: passed.
- ASCII, final-newline, and trailing-whitespace scan: passed.
- `git diff --no-index --check /dev/null <owned-file>` for each product file:
  no diagnostics; exit 1 because files are untracked in this baseline.
