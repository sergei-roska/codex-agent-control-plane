# Native planner writable-role scope mismatch
Read active junior_worker TOML developer_instructions. Cwd Harness repo.
Root owns Git. Edit only src/concurrent-delivery-engine.js and
 test/server-delivery-engine.test.js. Preserve committed42af839 source.
No provider turns, service restart, unsafe-runtime replay or DB mutation.

Actual native first arm failed before any specialist execution. Evidence:
../qualification/native-empty-writer-scope-repro.json and
../live-runner/concurrent-v1-1793890738510.evidence.json / its pre-close backup.
Planner emitted engineer kind diagnostic, productWritePaths=[], readScope4files.
Plan accepted, claim persisted, but checkSpecialistRequest throws BoundaryViolation
Writable role engineer requires explicit allowedFiles. No executor intent or role
execution exists. This became attempt_error and held claim; source shutdown unsafe.
Do NOT weaken the valid specialist writer-scope guard or mutate held state.

Fix the native planning contract to reflect actual configured role capabilities:
writable roles must have nonempty productWritePaths; a no-write diagnostic should
use an available read-only role. Native task schemas must enforce this relation,
not merely add prompt guidance. Derive groups from roleFor role.sandbox, no hardcoded
trial IDs/paths or changed goal. Nested anyOf task objects for read-only vs writable
role groups are one compact option; avoid per-task/per-role Cartesian expansion.
Preserve create/update/supersede revision/lineage pins and allowed-role exclusions.
Do not add unrelated restrictions on valid read-only tasks. Expose relevant scope
capability guidance in prompt so models can choose supported tasks honestly.

Add failing-before regression using actual generated schema and actual specialist
request contract: empty writable scope is unrepresentable, nonempty writable scope
and empty read-only diagnostic remain usable. Cover create/update/supersede and
retain existing CAS/history assertions with adapted schema traversal. No validator,
executor recovery, claim release or permissions changes in this repair.

Run focused schema regressions and affected server/contracts/recovery/planner suite.
Freeze after pass; root handles full suite, critic, local commit and fresh arm.
Write concise handoff/evidence in this directory. If exact enforcement encounters
native schema limitations, report concrete obstacle before altering scope.
