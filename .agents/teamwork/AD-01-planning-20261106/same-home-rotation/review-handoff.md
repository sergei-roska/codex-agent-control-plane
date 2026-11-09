# AD-01 same-home generation fence review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Re-review scope and resolved finding

Reviewed only the busy cross-home switch fix requested in `fix-brief.md`, its regression test, the actual source diff/current lifecycle paths, and the updated implementation handoff.

The prior blocking finding at `src/app-server-switch.js:116-117` is resolved by the new guard at lines 118-122: when a bound call cannot select the requested home while another call remains in flight, it throws `provider_home_switch_busy` before reserving, binding, or invoking. The retry loop no longer continuously schedules resolved promises in this state. The existing active call can complete normally, and a subsequent retry lets settle() perform the requested profile swap.

## Re-review criteria

- PASS (read + ran): busy switch A -> B rejects a second bound call with the stable fail-closed error rather than starving timers/I/O.
- PASS (read + ran): regression asserts exactly one A instance, no close while A is active, exactly one A target call, and no additional persistence binding for the rejected call.
- PASS (read + ran): after the timer-held A call completes, retry creates B, closes A, invokes only B, and records hashes in sequence [A, B].
- PASS (read + ran): regression runs in a separate Node child with parent-enforced 1500 ms spawnSync timeout. A return of the original microtask spin cannot hang the main runner; timeout and nonzero child exit fail assertions.
- PASS (read + ran): wrapper suite continues to cover same-home idle recreation, active-call fencing, callback-time identity replacement, close/create/callback/missing-identity failures, expected-home checks, and separate worker/lead bindings. No assertions were weakened or reviewed production behavior hardcoded.

## Verification

- Independently ran `node --test test/app-server-switch.test.js` after the fix: 17 passed, zero failed/skipped; isolated regression passed in approximately 77 ms.
- Prior independently run command before this narrow fix: `node --test test/app-server-switch.test.js test/durable-store.test.js test/e2e.test.js`: 49 passed, zero failed/skipped (wrapper 16, store 20, e2e 13 including parent suite test). Reused unchanged store/e2e evidence; the implementation handoff also reports fresh store 20/20 and e2e 13/13 after the fix.
- Before the fix, independently reproduced starvation with actual wrapper and synthetic A/B homes: held A awaited a 30 ms timer; selection B plus second bound call prevented both calls settling, causing parent timeout at 1500 ms with ETIMEDOUT/SIGTERM. The added regression exercises that same failure mechanism plus stronger preservation/retry assertions.
- No source/test/Git state changes, live provider calls, credential edits outside disposable homes, or service activation performed during review. The only review write is this report. Test temporary homes are cleaned on successful child completion.

## Original milestone criteria retained

The earlier review passed generation-pinned hashed binding, same-home rotation fencing, callback/immediate pre-invocation identity checks, scoped fail-closed error handling, and the explicit limit on external CLI guarantees. Its only failed criterion was the busy cross-home switching path; that criterion now passes as described above. The narrow guard does not alter the identity pins, persistence record, or invocation rechecks.

External CLI credential reload remains unverified and belongs to AD-08 qualification. This approval covers the repository-enforced App Server object-generation fence; call_bound remains evidence of binding persistence, not provider execution, completion, or effect.

Blocking: none.
Next action: lead integrates this reviewed milestone and preserves the runtime qualification limitation.

Pitfall: awaiting already-resolved promises in a retry loop does not yield to timers or I/O; busy state needs a real wait or explicit rejection.
