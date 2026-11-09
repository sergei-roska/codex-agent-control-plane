# AUT-01 P1.3 handoff

## Result

- Added `src/spec-assignment-adapter.js` and focused tests. `adaptAssignments`
  compiles every map task into engineer/verifier proposals and adds an auditor
  for gated risk kinds.
- Uses loaded real roles and validates a defensive assignment copy with
  `validateDecision`, plus the trusted-workspace direct request with
  `checkSpecialistRequest`. Returned proposals contain no workspace path or
  live attempt identity.
- Inputs, acceptance text, and evidence are extracted from bound source spans;
  evidence carries its source digest. Check commands come only from selected
  catalog entries. No constraint is truncated.
- Risk tags include linked requirements, matching implementation and selected
  verifier-scope rules, and task additions, with risk-change/performance/
  component-complete precedence. Every checkpoint has identical six-field
  review metadata across its proposals.
- Gated auditor scopes are empty and its checks state that verifier execution
  evidence is pending. Future evidence dependencies remain explicitly
  unavailable. `implementationAcceptance` is `not_evaluated`.
- Prior P1.1/P1.2 source, schemas, accepted context, and fixture bytes were not
  modified.

## Verification

- Command: `node --check src/spec-assignment-adapter.js && node --check test/spec-assignment-adapter.test.js && node --test --test-isolation=none test/spec-context.test.js test/spec-analyzer.test.js test/spec-assignment-adapter.test.js`
- Result: 27 passed, 0 failed, 0 skipped.
- ASCII scan of adapter source, tests, and local API/brief/handoff passed.
- No full repository suite, model, service, planned check, or live dispatch was
  run.

## Frozen hashes

- `src/spec-assignment-adapter.js`: `9a02d34d28a8fe9b19fdd4c82771aeb04ffd552cb7c97653dc15ed5239d194e3`
- `test/spec-assignment-adapter.test.js`: `b0c2a8ff4f650e7df529c31fcba54f91dff4b15f2818c827b0af8936e477d588`
- `.agents/teamwork/aut01-adapter/api.md`: `7452c8e149392e30036a813fd280db1447e6ff20dec94433c8d81dc545506383`
- `.agents/teamwork/aut01-adapter/brief.md`: `df5f5028ef3ffbfc9e7e2d5fedd20a9fb0ade6af792bfd066820f70c1e6fa81a`

P1.3 files are frozen for independent review. P1.4 report assembly and CLI are
not implemented.
