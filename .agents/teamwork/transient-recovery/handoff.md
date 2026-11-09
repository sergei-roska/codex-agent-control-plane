# A1 transient recovery handoff

Status: implementation complete; independent review approved; challenger accepted.

The durable `transient_recovery` SQLite table retains attempt count, due time,
category/cause, checkpoint ID, and state. Bounded exponential backoff with jitter
reloads across process restart and serializes per-run dispatch. Automatic resume
requires auto-resume enabled and a durable dispatched record matching the exact
attempt and checkpoint IDs supplied by the loopback message. The record must
also pass an inactive INPUT_REQUIRED task check, unchanged checkpoint check,
no pending graph interrupt, exactly `decide` next, and no unresolved writers.
Continuation retains the selected model and checkpoint resume semantics. Failed
loopback delivery consumes the attempt budget.

Owner `/control/pause` suspends waiting and dispatched recovery; its cancel route
re-arms a paused retry. Task cancellation deletes recovery state. Exhaustion and
retry time appear in task status text. Scheduler updates to pause metadata/text
use a guarded SQLite projection and A2A SDK message serialization. Explicit
provider `rateLimitExceeded` takes precedence over Codex's generic `usage_limit`
failure class for Lead recovery. Explicit quota remains on the budget watcher,
and untyped nested HTTP 429 preserves the legacy budget path. Shutdown aborts
active loopback recovery and drains it concurrently with executor settlement
under the existing 5-second stage bound; delayed preflight completion after DB
close exits before store access. Historical owner-pause flags clear at each new
Lead invocation.

Files: `src/transient-recovery.js`, `src/server.js`, `src/lead-orchestrator.js`,
`src/lead-graph.js`, `test/transient-recovery.test.js`, `test/server.test.js`,
`test/lead-orchestrator.test.js`, `test/e2e.test.js`,
`docs/transient-recovery.md`, `README.md`, and
`docs/orchestrator-improvement-backlog.md`.

Verification: final affected command `node --test test/transient-recovery.test.js
test/server.test.js test/e2e.test.js` passed 113/113. It includes a real
startServer close with stalled recovery preflight, which closed in about 5.05
seconds and handled a late rejection after SQLite closed without dispatch. The
disabled/stale retry challenger probe returned `resumes=0`; attempt/checkpoint
identity mismatch tests pass. Earlier six-suite snapshot before the final gate
adjustment passed 456/456. Accepted full suite: 1,395/1,404 pass, 8 unchanged
baseline failures, 1 skip, no new failures. No live provider outage, production
restart, or real model turn was used. No commit was made.

## Final lead checkpoint

Committed prior repairs/audit as a34de1e, then accepted A1 as 2a9f65a.
Working tree clean after commit. Critic APPROVE, challenger HOLDS.
Final full suite evidence: accepted-full-tests.log and accepted-comparison.json
(1404 total,1395 pass,8 known baseline failures,1 skip,no new failures).
Final affected suite113/113; exact adversarial probes pass with zero resumes.
No live lifecycle, target edits, deployment or real provider/model trial occurred.
Fresh native quota8% five-hour/55% weekly remaining; 90% usage dispatch stop applies.
No new A2 work started. Next concrete action after quota recovery:
read next.md, fresh status/quota, and define A2 preflight/persistent-decision scope.

Owner subsequently requested application shutdown. Verified launcher PID250326
received SIGTERM and exited. No Harness launcher/project-server processes remain;
registry project PIDs are null. Do not restart/resume automatically.
