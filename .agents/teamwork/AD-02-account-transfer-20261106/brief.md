# AD-02 legacy account failover context transfer

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `.agents/teamwork/AD-02-03-research-20261106/map.md`, AD-02 in `docs/autonomous-delivery-backlog.md`, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Prove and, only if the test exposes a defect, fix that a legacy objective paused for a detected account-A limit continues automatically on account B with the same durable objective/task/check contract while using a fresh provider thread. Use the existing temporary server/account-profile and fake-provider seams. No live provider or actual quota exhaustion.

Inspect the real `LeadOrchestrator`, lead graph session thread handling, and `budgetWatcher` resume flow. Existing account switching alone is insufficient evidence. The second account must not be sent account A's provider thread ID. The objective's durable graph/checkpoint state and pinned contract must continue; preserve the same A2A task/run and context scope; the new provider call must bind to B's configured identity. Preserve unknown outcomes and fail closed if safe context transfer cannot be established.

## Allowed files

- `src/budget-watcher.js`
- `src/lead-graph.js` (only if a focused failing test proves a defect; do not change AD-01 call-binding code)
- `src/session-threads.js` (only if a focused failing test proves a defect)
- `test/account-failover-context.test.js` (new focused integration test)
- this task's `handoff.md`

No other agent owns these paths. Do not edit app-server-switch, server composition, durable-store, other tests, UI, or unrelated code. If the fixture needs an additional production path, report the exact path and reason before expanding.

## Acceptance

- A disposable profile-A/profile-B fixture starts one real legacy objective and deterministically reports A's model operation blocked, then B available.
- The budget watcher selects B and resumes automatically without an owner message or objective re-intake.
- The run/task identity, A2A context ID, pinned acceptance contract/check identity, and previously settled objective state are preserved.
- B receives a fresh provider thread ID; the recorded A thread is not resumed on B. The durable session-thread record shows B's home, and durable provider call bindings trace both accounts by hash without exposing raw identifiers.
- The run continues or reaches an honest waiting/error state; no acceptance shortcut or duplicated writer effect is possible.
- Use only fake App Servers and isolated temporary state/profile/workspace data. Run the new test and any directly affected budget-watcher tests; report exact counts and whether source fixes were needed.

No live account read, real quota use, production activation, or Git state changes. Update the handoff with the fixture's actual evidence and any provider-integration limits.
