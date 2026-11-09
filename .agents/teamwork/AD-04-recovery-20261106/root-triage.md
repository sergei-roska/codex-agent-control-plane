# AD-04 root verification triage

Date: 2026-11-06. Status: original stall diagnosis resolved; independent-review
repairs remain active.

Root ran this isolated test after an earlier full-file verification stalled:

```text
timeout -k 1s 20s node --test --test-name-pattern='retry exhaustion blocks recovery after an actual stale A2A continuation' test/lead-graph.test.js
```

That timeout was caused by stale scripted turns: the review gate correctly
rejected terminal finish, then the fixture supplied no fresh planning response.
The stale malformed-endpoint fixture had the same issue. After both fixtures
were repaired, `timeout -k 1s 180s node --test --test-concurrency=1
--test-reporter=spec test/lead-graph.test.js` passed 287/287 in 17.2 seconds.

The subsequent independent review found two new AD-04 acceptance blockers:
the transient cap has no durable scheduled next action, and a persisted
threshold-only owner grant remains executable after restart. See
`review/handoff.md` and the active repair brief. Do not treat the earlier test
stall as unresolved or claim AD-04 complete until both review findings pass a
delta review.
