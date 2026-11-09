# AD-06 acceptance integration map

Role: explorer (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, the AD-06 section of `docs/autonomous-delivery-backlog.md`, and `/home/sr/codex-work/agents/explorer.toml` before inspecting.

## Goal

Map the current acceptance path against AD-06 so the lead can assign a bounded implementation slice while AD-01 work continues. Inspect both the legacy default runtime and concurrent engine, including candidate/effect integration and restart persistence. Do not edit product code, tests, fixtures, config, or tracked docs.

## Report

Write only `.agents/teamwork/AD-06-acceptance-20261106/map.md` (under 800 words). Ground each finding in `file:line` and relevant existing test names. Compare the stated AD-06 scenarios: pending successor, failed/missing pinned checks, stale candidate receipt, unknown writer effect, fresh checks against current candidate, durable accepted fingerprint across restart, and successor rebasing. Separate implemented facts from gaps. End with the smallest disjoint implementation slice that can begin before AD-01 completes and identify files it would own; do not prescribe speculative redesign.

No tests, source edits, Git operations, live provider calls, or broad repository survey. Report under 150 words and end with `Status: complete | partial | blocked` and `Scope expansion: none`.
