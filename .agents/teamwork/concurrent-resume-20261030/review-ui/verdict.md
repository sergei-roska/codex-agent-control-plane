# UI review: decision acknowledgement

Verdict: REJECT
Status: complete
Scope expansion: none

## Blocking

1. launcher-ui/app.js:1488: An old project's executeA2A completion unconditionally sets global sending=false while a new project request is still pending. Read: selectProject calls resetSessionView, which resets sending and permits another send in the new project; sendMessage has no additional sending/decisionSubmitting guard, and composer protection uses this global flag. The pid guard now occurs after the destructive assignment. Ran: an owned probe using actual selectProject/resetSessionView and executeA2A starts request A, switches to project B, starts B, then resolves only A; sending changes true -> false while B remains pending. Fix: associate in-flight state with a request/scope token, and only let its current owner clear it; recheck ownership after awaited polling before altering pending/render state. Cover old-project completion while a new request is pending.

2. launcher-ui/app.js:985: Polling a transient non-paused task while a decision is pending clears decisionCardKey. When the same decision subsequently returns an INPUT_REQUIRED error, submitDecision correctly reports failure but its final updateDecisionCard treats the pause as new and resets selectedDecisionOption at line1002. Ran: submit with choice keep, poll WORKING, return the identical original pause as semantic error -> outcome.ok=false, draft retained, selectedChoice empty. Fix: retain the submitted pause identity through intermediate polling, and preserve its choice on failed acknowledgement when the original decision remains current; add the intermediate-poll regression.

## Evidence

- Ran: node --test test/launcher-decision-ui.test.js test/launcher-session-controls.test.js -> 20 passed, 0 failed. Log tests.tap.
- Ran: node .agents/teamwork/concurrent-resume-20261030/review-ui/probe-races.cjs -> exit0, both failure scenarios observed. Results probe-races.jsonl. Probe loads actual app functions via the worker's VM harness and stubs network/UI dependencies; no network calls or live task submissions occur.
- Frozen Git blob hashes confirmed before/after: app.js9d291fd84d8be854f9ba2f89bae71170ff516551; test adf156e69ac79c3205923859bfc5d910b699b1ca.
- Read: callers, project reset, session selection, polling, composer, transcript and decision card lifecycles, in addition to the scoped diff/new tests.
- No product/test edits, live service starts, live task submissions, or DB writes. Backend changes excluded.

Pitfall: A stale async completion must not clear global state owned by a newer request, and transient polling states must not discard pending decision identity.
