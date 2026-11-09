# Performance overlay challenge

Verdict: BROKEN
Status: complete
Scope expansion: none

## Failure: incomplete live detail overwrites known snapshot task values

Probe: `.agents/teamwork/ui-settings-challenge/probe-performance-overlay.js` runs the actual `launcher-ui/performance.js` in a VM with mocked fetch APIs and a small DOM. The snapshot endpoint returns task `worker-1`, assignment `lead:r1:a0`, with 12 known tokens and 100 ms. Detailed usage for the same assignment contains only one partial live attempt with 4 tokens and 40 ms; its session total is unknown. The project and session IDs agree across URLs and payloads.

Expected: Preserve the snapshot's 12 known tokens and 100 ms on this task while live detail is incomplete. The displayed session total remains 12, so a task row of 4 is internally inconsistent.

Actual: The row shows 4 tokens and 40 ms, while session total shows 12. The assertion for the known row value fails. Exact command: `node .agents/teamwork/ui-settings-challenge/probe-performance-overlay.js`.

Cause: `mergeLiveTokenData` in `launcher-ui/performance.js` uses any finite live aggregate to replace a finite snapshot field, without determining whether the live aggregate covers all snapshot attempts. `preserveKnown` guards only null values. This was introduced by the overlay change; before it, the snapshot row remained 12 tokens and 100 ms.

## Other checks

Read the actual refresh and fallback paths. They guard asynchronous responses by request ID and project/session ID before assigning state; no independent stale-response failure was established. The existing focused test exercises retry grouping by assignment. No live service, profile, model, or Git action was used.
