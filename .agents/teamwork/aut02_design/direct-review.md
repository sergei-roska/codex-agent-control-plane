# AUT-02 direct verifier origin repair review

Verdict: REJECT (partial direct-scope review; final R4 review remains required).

Blocking:

- `src/a2a-role-service.js:485-491` [read]: Origin lookup filters out same-attempt/checkpoint rows whose target is not a string, then accepts one unique remaining target. If one valid origin and one malformed origin exist, it treats corrupt evidence as unambiguous and may execute a stale continuation. The `limit:10000` query also cannot establish uniqueness when older conflicting rows fall outside the returned window. Fix: inspect all matching rows before discarding malformed entries; reject any malformed target and fail closed when the bounded query is saturated, or query all rows for that exact run/type/attempt/checkpoint using a targeted store API. Add mixed valid/malformed and saturated-history probes.

Evidence:

- [read] `git diff -- src/a2a-role-service.js test/a2a-role-service.test.js` shows the new verifier origin guard, same-target test, and missing/cross-run/corrupt/ambiguous tests. `src/contracts.js:308-349` normalizes all six review fields; `src/review-policy.js:34-41,139-151` binds them to target identity. `src/staging-log.js:243-252,277-285` limits returned events before the caller filters by attempt/checkpoint.
- [ran] `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='direct verifier continuation|auditor continuations|pinned-check fallback continuation|every normalized review field' test/a2a-role-service.test.js test/review-policy.test.js`: 7 pass, 0 fail, 0 skip.
- [ran] `node --test --test-isolation=none --test-reporter=tap --test-name-pattern='legacy plain text|auditor accepts a stable scoped owner review|non-auditor direct calls retain plain-text' test/a2a-role-service.test.js`: 3 pass, 0 fail, 0 skip.
- [read] `src/a2a-role-service.js:613-646` checks verifier continuation before `appServer.run`; same-target origin remains admissible. `investigation` verifier is explicitly excluded from this new guard; plain unstructured requests never enter it. Existing auditor and pinned fallback use their prior origin types. Same-run verifier lookup requires runId, and the direct target comparison stays within the direct boundary.

Non-blocking: The existing auditor/pinned lookup still allows runless requests; its prior behavior was not changed by this repair. If run identity is required uniformly for every review continuation, handle that as a separate compatibility decision.

Pitfall: A unique value in a truncated or partially filtered evidence set does not prove a unique origin.

Status: partial
Scope expansion: none
