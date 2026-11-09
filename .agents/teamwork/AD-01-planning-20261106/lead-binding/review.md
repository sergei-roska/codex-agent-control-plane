# Independent lead binding review

Verdict: APPROVE
Blocking: none. The previous raw-adapter bypass is closed at `src/lead-graph.js:2953`, before attempt creation or provider invocation. Ran: the lead raw-adapter regression rejects with provider_call_binding_unavailable, zero provider calls, and zero journal attempts. The worker boundary retains its matching guard at `src/a2a-role-service.js:1052`; its raw-adapter regression also passes with zero calls.
Non-blocking: The isolated stale-review regression now passes after fixtures implement the binding boundary; no recovery assertion was weakened.
Non-blocking: Same-home credential replacement remains the declared unobserved boundary.
Pitfall: Passing correlation options does not prove that an adapter persists them.
Status: complete
Scope expansion: none

## Re-review evidence

Scope: only the previous blocking finding's delta and affected fixture changes. Read the actual source/test diff. The lead capability check executes inside runLead before journal.recordSubmitting and appServer.run, covering initial calls and rejected-continuation fallback calls, including direct LeadOrchestrator and injected startServer adapters. A correlated worker call is independently guarded in the role service. Direct worker requests without run/attempt lineage remain outside that correlated-call requirement, as before.

The lead test fake now persists each supplied callBinding through the current session journal before returning the scripted provider response. Session reopen replaces the callback with the reopened journal. The raw-adapter regression deletes capability support and asserts refusal, zero calls, and zero attempts. Existing stale-review assertions are unchanged.

Ran:

- `node --test --test-name-pattern='lead planning fails closed before calling|trusted pre-turn stale rejection does not consume a verifier recurrence attempt' test/lead-graph.test.js`: 2/2 passed.
- `node --test --test-name-pattern='raw App Server adapters fail closed for correlated provider calls' test/a2a-role-service.test.js`: 1/1 passed.
- `git diff --check -- src/lead-graph.js test/lead-graph.test.js`: passed.

Reused valid prior independent evidence for unchanged persistence/wrapper paths: `node --test test/app-server-switch.test.js test/durable-store.test.js test/e2e.test.js` passed 45/45, including migration, worker pinning, reopen, rejected continuation, and graceful restart. The worker reports current lead-graph 284/284; that full rerun was not independently repeated because targeted checks resolve this delta.

## Original review evidence retained

The original raw-adapter probe completed one lead provider call and recorded a finished attempt with no binding. This was the sole blocking finding and is now prevented by the capability gate.

Before the fixture repair, both current lead-graph and HEAD lead-graph compiled at its original filename through a temporary CommonJS loader produced the same 11 failures among 283 tests. The isolated stale-review case failed with partial versus expected undefined. That established that the lead-binding slice did not cause those failures. Read: direct-service fixtures lacked the adapter required by the existing worker-binding guard. The repaired fixture and unchanged isolated expectation now pass.

Prior read/ran findings remain valid: migration preserves worker bindings while permitting null lead task IDs; the journal validates coordinator lineage and worker task pinning; the switching wrapper awaits persistence and holds its selected target; invocation identities survive reopen/restart; returned/rejected promise settlement does not claim a provider turn or effects; an uncompleted attempt remains submitting.

Temporary evidence, which may disappear: `/tmp/lead-binding-critic-rereview.log`, `/tmp/lead-binding-critic-focused.log`, `/tmp/lead-binding-critic-isolated.log`, `/tmp/lead-binding-critic-lead-current.log`, `/tmp/lead-binding-critic-lead-baseline.log`, `/tmp/lead-binding-critic-baseline.cjs`.
