# AUT-01 P1.1 handoff

## Starting state

A0 is recorded passed in docs/evidence/aut-01/entry.json for AUT-05 v3 baseline digest 4fe46b3cc7d7a67e5bc1df2c5347f5bcd007fccb808a8294671d0a0ee0183786. Git status initially showed only lead-owned untracked docs/evidence/aut-01/. No context/analyzer implementation existed at task start.

## Scope

Worker owns new strict context/map schemas, src/spec-context.js, test/spec-context.test.js, and test/fixtures/spec-kit/pilot-price/** except context/accepted-context.json. Lead owns candidate context acceptance and Git/docs. This checkpoint does not implement analyzer, assignment adapter, or CLI.

## P1.1 implementation and candidate state

- Added strict draft-07 schemas, read-only context/map API, nine focused tests,
  and `.agents/teamwork/aut01-context/api.md`.
- Fixture is under `test/fixtures/spec-kit/pilot-price/`. It contains pinned
  canonical inputs, byte-preserving product copies, candidate spec/plan/tasks,
  one T001 map, and context. The lead has accepted the context and owns
  `context/accepted-context.json`; do not edit that file or any fixture input.
- Critic identified EVID-ACCEPTANCE-TESTS did not include subtotal lines 7-9.
  The approved bounded correction changed its source span to lines 7-21 and
  refreshed context and map context digests. Fixture bytes are now frozen for
  independent semantic review.
- Candidate context SHA-256:
  `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`.
- Derived artifact SHA-256 values: spec
  `857ba273c9e5a5dea3ad8133a48c24d4507ff3d3fd24a4f593fe9c568d6e098c`, plan
  `dad1df7d19a6ef67b27432bedb9bd6500e3c575e2a0889417a7e2a5e4588a5a7`, tasks
  `e1cc5e831cae34abace5aa719f35db11645f4f92138642bd9e15868b27ea12f7`, map
  `212f256587a672c4c6de818a67a52e8a0463663258f39756d9409a6e53be3ec8`.
- Product source, test, package, and check copies compare byte-for-byte with
  `bench/fixtures/f2-repair`; planned check was not executed.

## Verification

- `node --check src/spec-context.js` - passed.
- `node --test --test-isolation=none test/spec-context.test.js` - 13 passed,
  0 failed.
- Tests cover strict nested schemas, digest/source mutations, per-file and total
  source size bounds, nested references and spans, null and malformed context
  and map members, in-root symlink write aliases, new files inside allowed
  directories, write/risk/review constraints, artifact bindings, and LF/CRLF
  line extraction.
- Parent-plan bounds are reflected in implementation: context/map JSON 1 MiB
  each, source/artifact 4 MiB each, and source bytes 32 MiB total. The later
  analyzer must enforce the aggregate 32 MiB budget across all input classes.
- Current hashes: context schema
  `2a6874520d3f0013c9aff95660bec3aa3bde41321e50a5cea7dffb2972678e0f`, map
  schema `b1b1de5edc96662529e3726a1e5d663be27ca10184cb5b905e4409ecec778976`,
  source `054c6a90cf298d8f7b6ffff8cee72ffbd415a98c95abe87adc95fc6398e56228`,
  test `8529da89cb0860d88fce6af17e618405d53970cd3580fa9942ce9ecadb4de48d`.

## Pending

Source and test files are frozen for critic re-review. Context acceptance is
complete. No schema, fixture, or accepted-context files were changed for this
repair. The next analyzer/adapter/CLI milestone has not started. Lead-owned
`docs/evidence/aut-01/` remains untouched.
