# CN-01 worker state

Owner: delivery-contracts worker. Scope: new `src/delivery-contracts.js`,
`schemas/delivery-v1.schema.json`, `test/delivery-contracts.test.js`, and this
ignored handoff directory only. Implement pure versioned validation and plan CAS
contracts. Do not wire legacy scheduling or edit root docs/other dirty files.

Acceptance: stable bounded IDs, finite revisions/counts, typed errors and paths,
record validation, explicit write/scratch/resource/publication dimensions,
unknown read scope, dependency project/reference/cycle validation, immutable
active task revisions, stale plan/authority/goal/control rejection, and tests
for the brief's realistic/negative cases. Node CommonJS and node:test.
