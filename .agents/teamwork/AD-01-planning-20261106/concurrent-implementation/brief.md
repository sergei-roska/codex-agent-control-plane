# AD-01 concurrent durable objective qualification

Role: junior_worker. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Baseline source: `ab5c195`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, `.agents/teamwork/AD-01-planning-20261106/contract.md`, this brief, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Implement and verify the AD-01 concurrent-path slice. The canonical owner objective is one `(projectId, initial taskId)`; preserve the current deterministic objectiveId mapping. Add a composed restart/continuation acceptance regression using existing persistence and recovery components. Prove immutable goal, project/workspace scope, required check identities, checkpoint and attempt lineage survive close/reopen without re-intake or duplicate writes. Preserve current provider pin/fencing behavior; do not implement automatic account selection, failover, wait, or quota resume. Follow the shared identity contract.

## Allowed files

- `src/delivery-engine-router.js`
- `src/concurrent-delivery-engine.js`
- `test/delivery-engine-router.test.js`
- `test/concurrent-delivery-engine.test.js`
- `test/server-delivery-engine.test.js`
- `test/delivery-migration-qualification.test.js`

Inspect first and edit the minimum needed from this list. No other worker owns these files. Do not edit `src/server.js` or legacy path files. If the acceptance case exposes an unsafe missing binding, fix it only within the allowed source files; otherwise report a concrete scope boundary.

## Acceptance

- The regression uses deterministic local fixtures, starts one project objective, persists a checkpoint and worker attempt, closes/reopens the composed project runtime, and resumes the same mapped objective with the original goal/scope/check identities and traceable attempt lineage without resubmitting intake.
- Changed or missing required bindings remain incomplete/unknown and cannot dispatch writes or become accepted. No identity is inferred from contextId or similar goal text.
- Existing fencing, effect settlement, and provider identity pinning remain enforced.
- Run the narrow relevant Node tests and report exact commands/counts. Do not run the full suite unless focused results or source changes justify it. No live provider/quota use.

Update only `.agents/teamwork/AD-01-planning-20261106/concurrent-implementation/handoff.md` with changed files, evidence, exact checks, remaining gaps, and next action. Do not alter user-owned backlog files or Git state. Final response under 200 words with `Status` and `Scope expansion`.
