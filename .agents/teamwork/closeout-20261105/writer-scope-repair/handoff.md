# Planner writer scope repair handoff

Status: implementation complete, focused and affected suites passed, candidate frozen for root full-suite and critic review.

The planner now derives writable and read-only role groups from `role.sandbox`, excludes the existing host-controlled roles, and exposes both groups in policy guidance. Every create, update, and supersede task schema contains the same two nested role-group variants. Writable-role variants require `productWritePaths` with `minItems: 1`; read-only variants retain the existing path array without a minimum. Existing revision, lineage, allowed-role, state, and publication rules remain in place.

The regression invokes `checkSpecialistRequest`: empty writable scope is rejected, nonempty writable scope is accepted, and empty read-only diagnostic scope is accepted. It checks the generated strict schema for create/update/supersede and retains the supersession CAS/history assertions.

Before source changes, `node --test --test-name-pattern='planner sends a strict usable schema' test/server-delivery-engine.test.js` failed 0/1 at `task branches must separate writable and read-only role groups`, proving the current schema had no capability-specific shape.

Final verification:

- `node --check src/concurrent-delivery-engine.js` - passed.
- `node --check test/server-delivery-engine.test.js` - passed.
- `node --test --test-name-pattern='planner sends a strict usable schema|planner schema represents a distinct repair superseding a failed task' test/server-delivery-engine.test.js` - 2 passed, 0 failed.
- `node --test test/server-delivery-engine.test.js` - 82 passed, 0 failed.
- `node --test test/delivery-contracts.test.js` - 16 passed, 0 failed.
- `node --test test/concurrent-recovery-acceptance.test.js` - 1 passed, 0 failed.
- `node --test test/lead-planner.test.js` - 11 passed, 0 failed.
- `git diff --check -- src/concurrent-delivery-engine.js test/server-delivery-engine.test.js` - passed.

No provider turns, live calls, runtime restarts, recovery/claim mutations, validator changes, or Git mutations. No additional changes after freeze. SHA-256: engine `2c5d35f0d7c5653a263657f01cfb2349cf2f334470b41823ecab0fd02afffa8a`; test `14f731ca1bf323f2935ad1f7212e1066056d4a32d72b6fdbe4793f567e308930`.
