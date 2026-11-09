# Scheduler poll rearm repair

Cwd: /home/sr/Projects/Workspace/codex-agent-control-plane
Owner: middle_worker. Allowed product writes: src/task-scheduler.js and
 test/task-scheduler.test.js only. Root owns Git and durable docs. Preserve all
inherited uncommitted work. No Git mutation, service restart, provider calls,
account/settings changes, dependency installation, deployment or live target work.
Node CommonJS, existing node_modules. Use env -u NODE_TEST_CONTEXT node --test.
Write concise handoff/evidence in this directory (worker-handoff.md, worker.tap).

Read predecessor ../cn14-facade-20261028/handoff.md and especially
../cn14-facade-20261028/correction/final-full-diagnosis.md; inspect current source.
An early timeout callback (deadline1200, callback1199) loses the only poll timer
for a submitted intent. Deterministic real-store reproducer:
../cn14-facade-20261028/correction/early-poll-repro.cjs. Historical full suite
also saw a direct-resume timeout, but historical causality is not established.

Repair future poll rearming with deterministic retained regression tests. Ensure
normal polling remains live; stopped scheduler has no timers; parked/unknown and
stale deadlines do not cause busy polling or resend. Do not weaken effect fences,
change goal/recovery behavior, or increase acceptance wait timeouts. Keep scope
narrow; report necessary expansion before editing other product files.

Acceptance: early callback rearms, due callback polls exactly once, no busy loops
for ineligible/stale/parked intents, existing scheduler and executor tests pass.
Demonstrate regression fails against preserved original source, then passes repair.
Run affected tests; independent critic and challenger follow. Never run the test
named candidate attributes and inherited Git configuration cannot execute filters while mirroring.
Any delivery-acceptance or full run MUST include:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Read/apply /home/sr/codex-home/agents/middle_worker.toml developer instructions
and /home/sr/codex-home/development-access.md. Report exact checks/results, files,
uncertainties, and handoff path in ASCII English. Do not write quota to handoffs.
