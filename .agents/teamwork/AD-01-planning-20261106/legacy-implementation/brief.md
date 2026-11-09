# AD-01 legacy durable objective binding

Role: junior_worker. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Baseline source: `ab5c195`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `.agents/teamwork/AD-01-planning-20261106/contract.md`, this brief, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Implement and verify the AD-01 legacy-path slice. The legacy `taskId`/`runId` is the stable objective identity within its project. Bind its original project/workspace scope and pinned goal/check contract to durable task/checkpoint recovery so restart cannot silently continue under a changed workspace or replace pinned checks. Preserve the existing checkpoint and dispatch journal attempt lineage. If provider/account identity is available at the point attempts are recorded, preserve it per attempt; do not invent it or implement account switching. Follow the shared identity contract.

## Allowed files

- `src/server.js`
- `src/lead-orchestrator.js`
- `src/lead-graph.js`
- `src/durable-store.js`
- `test/durable-store.test.js`
- `test/lead-orchestrator.test.js`
- `test/lead-graph.test.js`
- `test/e2e.test.js`

Inspect first and edit the minimum needed from this list. The lead added `src/lead-graph.js` and `test/lead-graph.test.js` after the source map showed journal writes occur there, outside the original file set. No other worker owns these files. If a necessary change falls outside the list, report the specific reason and continue independent in-scope work.

## Acceptance

- A regression test creates an objective with explicit project/workspace scope and pinned required checks, persists a checkpoint and attempt, closes/reopens the server/store, and proves the same task/objective, workspace binding, pending work, and check identities are recovered without new intake.
- A changed project/workspace binding or missing mandatory binding cannot silently dispatch writes or become accepted; existing trusted histories remain resumable where their data is sufficient.
- Existing journal/checkpoint invariants and task/run IDs remain intact; no account failover behavior is added.
- Run the narrow relevant Node tests and report exact commands/counts. Do not run the full suite unless the focused results or source change justify it.

Update only your `.agents/teamwork/AD-01-planning-20261106/legacy-implementation/handoff.md` with changed files, evidence, exact checks, remaining gaps, and next action. Do not alter user-owned backlog files or Git state. Final response under 200 words with `Status` and `Scope expansion`.
