Status: complete for read-only diagnosis.

Completed:
- Compared active codex-home lead policy and worker/explorer role instructions
  against Harness profiles/TEAM.md and actual graph control flow.
- Independent scheduler trace: scheduler.md. Independent policy trace: policy.md.
- Root verified collect/pollItem, gateFailure, finish-partial, and lane admission.

Confirmed findings:
1. Same-wave isolated writable turns, including same-role assignments, can run
   concurrently. Shared fallback executes writers sequentially. Actual live-run
   isolation flag was not inspected; user observation alone does not establish it.
2. collect waits for all submitted workers to become terminal. No decide call
   occurs while collecting; early completion cannot trigger new lead planning.
   Lane patch integration can finish earlier independently under writer admission.
3. Incomplete critical review blocks unrelated writable assignments globally
   (src/lead-graph.js:1729-1750), not just dependent implementation.
4. A false-goal finish with a checkpoint ledger terminates partial immediately
   (src/lead-graph.js:3167-3169). This is a permitted path, not proof every
   historical partial was premature.
5. Existing instructions already request disjoint parallel waves, cohesive
   packages, investigation, and autonomous routine decisions. Prompts alone
   cannot provide missing runtime scheduling.

Recommendation, not implemented:
Use a persistent dependency-aware task queue, bounded worker pool, completion
notifications, and lead lookahead while workers run. Review immutable candidates;
localize write gates only after dependency and target-identity rules are designed.
Permit partial only after justified exhaustion of authorized recovery routes.

Changed files: ignored coordination notes only. Existing dirty product files
preserved. No tests, service changes, live model trials, Git mutations, or target
work. Verification: bounded source inspection; native quota read only at
2026-10-26T16:00:11Z, five-hour 99 percent and weekly 84 percent remaining.
Next action if implementation is requested: define dependency, candidate identity,
restart/replay, and cancellation invariants before a scoped worker brief.
