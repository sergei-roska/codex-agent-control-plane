# AD-01 lead planner provider-call binding

Status: implementation complete; the raw-adapter review finding is fixed.

## Implementation

- Every legacy lead `appServer.run()` creates a durable coordinator planning attempt and passes its correlation to the switching wrapper. The journal accepts `task_id = NULL` only for a coordinator attempt assigned to `<runId>:lead-planning`; worker calls still require and pin a non-empty A2A task ID.
- Lead calls now require `appServer.callBindingVersion === 'call-bound/v1'` before any provider invocation. Raw injected/direct adapters fail closed; test fakes explicitly implement the binding boundary and persist through the test journal.
- The wrapper hashes the selected configured account identity and durably appends a unique invocation binding before invoking the target. Missing identity or persistence errors fail before target invocation.
- A lead attempt finishes after the App Server call resolves or rejects, recording only `providerCall: returned|rejected`. A call-bound row alone leaves the attempt submitting/unknown. An interrupted process therefore retains the earlier binding and leaves an unfinished attempt unknown.
- SQLite migration relaxes the existing binding table task ID constraint while preserving worker rows.
- Same-home auth rotation now pins the hashed configured identity to each cached wrapper generation and fences in-flight replacement; see [same-home rotation handoff](../same-home-rotation/handoff.md). External CLI credential-file reload behavior remains unverified and is an AD-08 runtime assumption.

## Verification

- `node -c` for all changed source/test files and scoped `git diff --check`: passed.
- `node --test test/app-server-switch.test.js`: 12/12 passed.
- `node --test test/durable-store.test.js`: 20/20 passed, including migration and reopen.
- `node --test test/e2e.test.js`: 13/13 passed, including rejected continuation/fresh-call identities and durable restart records.
- `node --test --test-name-pattern='lead planning fails closed before calling' test/lead-graph.test.js`: 1/1 passed; raw adapter call count remained zero.
- `node --test test/lead-graph.test.js`: 284/284 passed after the capability-guard change. An earlier run had 11 stale-review recovery failures; the lead confirmed they also occur at HEAD. Follow intermittent stale-review cases under AD-04.
- No live provider calls, quota use, or Git state changes.

Status: complete
Scope expansion: none
