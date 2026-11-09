# HAR-03 shared Git routing handoff

Status: implementation complete; focused verification passed.

## Confirmed cause

`src/a2a-role-service.js:861-863` already bypasses the lane when the structured request has `executionTarget === "shared"`; lane Git metadata is private and patch integration does not commit the shared branch. The confirmed missing path was in `src/contracts.js`: the lead decision schema, `checkAssignment`, and `checkSpecialistRequest` did not declare or preserve this value, so the executor's existing selector could not receive it from an assignment. `checkSpecialistRequest` rebuilt an output object and silently dropped unrecognized fields. That made an explicitly authorized local Git commit remain in a lane and miss shared branch metadata.

## Design

The model-facing strict schema requires `executionTarget` as nullable (`null | "shared"`) so every property remains listed in `required`. Contract normalization injects `null` for absent fields from legacy checkpoints and callers. `"shared"` is accepted only for a writable engineering role (`engineer`, `recovery-engineer`, or `senior-engineer`) with `review:null` and `repair:null`; no objective/shell text inference. A shared-target writer is a singleton among writers in its execution group. The lead prompt retains the already-authorized local Git operation and no-reask guidance, without implying push or deploy authorization.

`checkSpecialistRequest` now preserves and validates the route; `/root/permissions` owns the executor change and has been given the nullable field contract. Verification: focused contract+lead tests pass (5/5 and 2/2); the complete scoped `node --test test/contracts.test.js` passes 51/51; `git diff --check -- src/contracts.js test/contracts.test.js src/lead-graph.js test/lead-graph.test.js` passes. Root's baseline full suite was 1356 tests: 1344 pass, 10 fail, 2 skip. No live commits or runtime actions.
