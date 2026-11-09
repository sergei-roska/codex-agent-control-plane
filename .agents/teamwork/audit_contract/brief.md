# Auditor report contract repair

Repair report validation and auditor instructions so scoped read-only audits can
return reliable evidence. Preserve strict standalone verdicts, scope and target
binding, stale receipt invalidation, pinned-check semantics, and mandatory check
failure behavior. Separate required checks from optional diagnostics and preserve
compatibility with stored worker reports. Do not edit src/lead-graph.js; coordinate
prompt changes with its owner.

Baseline: e5f5c6f plus predecessor dirty changes in the isolated worktree.

Owned files: src/review-policy.js, src/a2a-role-service.js, src/contracts.js,
profiles/agents/auditor.toml, related tests, docs/auditor-routing-contract.md,
and this handoff.
