# AUT-01 P1.1 source and schema review

Verdict: REJECT
Status: partial
Scope expansion: none

Reviewed frozen source `src/spec-context.js` SHA-256
`5737d85dfee972db433f9addb85ac70b25dbaee2940a4b3a517ebf44f431e775`;
context schema `2a6874520d3f0013c9aff95660bec3aa3bde41321e50a5cea7dffb2972678e0f`;
map schema `b1b1de5edc96662529e3726a1e5d663be27ca10184cb5b905e4409ecec778976`;
test `b9f04cd0784b586d077d11cd44a5f9a3482ca83666fe875f396da1952df4ff13`.
Candidate F2 context/map semantic review is separately APPROVED at context
44530cd6... and map 212f2565....

## Blocking findings

1. `src/spec-context.js:353` [ran/read]: `validateContext` records a bad
   `writeScope.allow` entry but then dereferences it. With the otherwise valid
   F2 context and `writeScope.allow=[null]`, it throws TypeError reading `kind`;
   `checks=[null]` also throws reading `verifierWritePaths` at line 359.
   `validateTraceability` similarly throws on a task write path with null or
   numeric `path` at line 183 after recording `path_unsafe`. Malformed nested
   input must return bounded structured findings. Guard or stop downstream
   semantic passes after shape errors, and add those negative cases.
2. `src/spec-context.js:194` [ran/read]: A proposed write can use an in-root
   symlink alias to bypass deny precedence. Scratch reproduction copied the F2
   fixture, accepted a directory allow/risk rule `product/src`, kept deny file
   `product/test/price.test.js`, created `product/src/alias.js` symlink to the
   denied test, and set T001 write path to the alias. `loadContext` and
   `validateTraceability` both returned `ok=true`. The path inspector checks
   workspace containment, while `scopeAllowed` and `rulesForScope` compare only
   lexical paths. Reject symlink write targets or apply allow/deny/risk rules to
   canonical targets, including alias ancestors, and cover the bypass in tests.

## Checks and scope

`node --test --test-isolation=none test/spec-context.test.js`: 9 pass, 0 fail.
`node --check src/spec-context.js`: pass. Independent malformed-input probes and
scratch symlink probe produced the failures above. No reviewed source, tests,
schemas, fixtures, or Git state were changed. Full analyzer/CLI integration is
outside this P1.1 checkpoint.
