# Repair lead brief

Owner: root (coordination, design, documentation, Git integration and acceptance).

User scope: repair equivalent repeated-auditor recognition, clarify truthful
read-only report contracts, and enable New session after confirmed owner pause/stop.
Implementation belongs to repeat_guard, audit_contract and session_switch workers.

Baseline and before-state: ../PROJECT.md and /tmp/cp-loop-audit-session-Y5u75p/baseline.
Original checkout: /home/sr/Projects/Workspace/codex-agent-control-plane.
Isolated worktree: /tmp/cp-loop-audit-session-Y5u75p/worktree.

Design decisions: scoped failed-review identity ignores paraphrased request checks
and incidental evidence IDs; candidate and actual performed-check changes are evidence.
Keep worker-report/v1 shape and strict standalone verdict. Supplemental/forbidden
checks and reused evidence go to risks with honest results; mandatory failed checks
stay in checks. Confirm settled owner pause/stop before UI context switch; preserve
old durable session and writer admission.

Review: one batched critic checks all three repairs and full suite; then challenger
probes concrete loop/receipt/session failure paths. Integrate only reviewed delta
after comparing original files to the snapshotted baseline.
