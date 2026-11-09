# AD-04/AD-05 diagnosis, recovery, and effect-control map

Role: explorer (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, AD-04 and AD-05 in `docs/autonomous-delivery-backlog.md`, `docs/autonomous-delivery-constraints.md`, and `/home/sr/codex-work/agents/explorer.toml` before inspecting.

## Goal

Trace current diagnosis/recovery and uncertain-effect/pause/cancel behavior across the legacy and concurrent paths. Identify what executable tests establish and what remains missing against AD-04 and AD-05. Keep facts and hypotheses separate.

## Report

Write only `.agents/teamwork/AD-04-05-research-20261106/map.md`, under 900 words. Include file:line evidence for diagnosis before owner questions/partial results, repeated failure handling and retry thresholds, durable intent/effect reconciliation after restart, owner pause/cancel fencing against dispatch/write/account changes, and automatic reconciliation when dependencies recover. Name exact relevant tests and the smallest independent implementation slices with file ownership that will not overlap the current AD-01/AD-06 owners. No source/test/config edits, no tests, no Git operations, and no live provider/quota use.

Return a summary under 150 words ending with `Status: complete | partial | blocked` and `Scope expansion: none`.
