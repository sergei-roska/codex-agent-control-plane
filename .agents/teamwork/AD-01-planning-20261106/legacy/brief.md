# AD-01 legacy-path evidence map

Role: explorer. Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`.
Baseline source: `ab5c195`; current checkout contains user-owned documentation changes. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, the current backlog-reset handoff, and `/home/sr/codex-work/agents/explorer.toml` before starting.

## Goal

Map only the legacy runtime path for AD-01 in `docs/autonomous-delivery-backlog.md`: objective identity, project/workspace scope, acceptance obligations/check identities, checkpoint, attempts, provider identity, persistence and restart recovery. Trace actual callers from server composition through stores/orchestration and tests; distinguish code from docs. Identify whether a bounded implementation slice can start independently and propose concrete files, test names/commands, and missing behaviors.

## Ownership and limits

Read-only for tracked source, tests, and docs. Write only `.agents/teamwork/AD-01-planning-20261106/legacy/report.md`. Do not edit the active backlog, user-owned modifications, source, tests, or Git state. Do not repeat unrelated archive research. No tests or live provider work needed.

## Report

Use concise evidence with `file:line`, label read/ran/hypothesis, list durable fields and each persistence/recovery edge, existing test coverage, precise gaps/uncertainties, and a proposed independently reviewable task boundary (not a design choice beyond evidence). Keep under 800 words. End with `Status: complete | partial | blocked` and `Scope expansion: none`.
