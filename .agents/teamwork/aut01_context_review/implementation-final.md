# AUT-01 P1.1 repair delta review

Verdict: APPROVE
Status: complete
Scope expansion: none

Frozen source SHA-256
`054c6a90cf298d8f7b6ffff8cee72ffbd415a98c95abe87adc95fc6398e56228`;
test SHA-256
`8529da89cb0860d88fce6af17e618405d53970cd3580fa9942ce9ecadb4de48d`.
The accepted F2 context remains
`44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`;
candidate map remains
`212f256587a672c4c6de818a67a52e8a0463663258f39756d9409a6e53be3ec8`.
Schemas and fixture content were unchanged in this repair.

The two prior blockers are resolved [ran/read]. With an otherwise valid F2
context, `writeScope.allow=[null]` and `checks=[null]` now return structured
errors without throwing. With a valid loaded context, map task write paths
containing null or numeric `path` also return `path_unsafe` and denial findings
without throwing. Scope comparison now guards malformed nested members.

The scratch symlink bypass probe now returns `mapOk=false` with
`path_symlink_forbidden`: an allowed `product/src/alias.js` resolving to the
denied product test cannot validate. Source review confirms `rejectSymlinks`
applies to write scopes, risk-rule paths, verifier scopes, and proposed task
writes, including existing ancestor components. The added positive control
accepts an ordinary new file beneath an allowed directory.

`node --test --test-isolation=none test/spec-context.test.js`: 13 pass, 0 fail.
`node --check src/spec-context.js`: pass. Independent probes reproduced the
previous failures and verified their corrected outcomes. No reviewed source,
tests, schemas, fixtures, or Git state were changed by this review. Analyzer,
assignment adapter, and CLI integration remain later checkpoints.
