# AD-02/AD-03 failover and durable wait source map

Role: explorer (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, AD-02 and AD-03 in `docs/autonomous-delivery-backlog.md`, and `/home/sr/codex-work/agents/explorer.toml` before inspecting.

## Goal

Prepare the next implementation handoff by tracing account selection/failover and budget wait/resume through the legacy default server and concurrent engine. Identify executable existing tests and exact behavioral gaps against AD-02/03. This is read-only research; do not infer capability from comments or docs without tracing code.

## Report

Write only `.agents/teamwork/AD-02-03-research-20261106/map.md`, under 900 words. Include file:line evidence for profile selection, provider identity pinning/thread context, quota signal discovery, durable wait state and restart wake eligibility, and the concrete adapter/composition boundaries. Separate legacy and concurrent paths. End with the narrowest implementation slices that can be assigned without overlapping the active AD-01 or AD-06 owners, plus their file ownership. No code or test edits, no tests, no Git operations, and no live provider or quota use.

Return a summary under 150 words ending with `Status: complete | partial | blocked` and `Scope expansion: none`.
