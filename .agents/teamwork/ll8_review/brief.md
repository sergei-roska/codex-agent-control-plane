# LL-8 acceptance review

Cwd: /home/sr/Projects/Workspace/codex-agent-control-plane.
Baseline: e5f5c6f; review working tree and new untracked loop-guard files.
Read your role TOML developer_instructions and AGENTS.md before work.
English ASCII reports. No product edits, Git mutations, services, live API runs.

## Criteria

- Healthy default runs have no dispatch round cap. Explicit maxRounds is an
  optional caller allowance without automatic progress/investigation increases;
  owner continue/change_goal may extend it. Legacy checkpoints resume safely.
- Bounded deterministic detector identifies unchanged repetitions and A/B cycles,
  warns in an actual lead turn before pausing, lets relevant new evidence advance,
  and resists ID/time/failure prose churn and unrelated-work warning laundering.
- Budget and process recovery retain detector history; duplicate observations and
  partial continuations do not inflate it. Owner loop decision resets deliberately.
- Pause routing preserves writer reconciliation, review gates and acceptance.
- Only actual LangGraph recursion errors with proven checkpoint advancement roll
  forward using null input. Resume commands and dispatch effects are not replayed.
- User-requested local teamwork rules and gitignore work; docs match implementation.

Prior accepted OPS-04 changes share src/lead-graph.js, a2a-role-service.js,
review-policy.js, writer-lanes.js and tests. Preserve them; inspect interaction,
but avoid repeating an unrelated full review. Root owns final full suite.

Run focused checks only to resolve a concrete uncertainty; use
`env -u NODE_TEST_CONTEXT node --test ...`. Existing /var/tmp and local HTTP
fixtures may need the normal escalation path, never bypass sandbox restrictions.
Report APPROVE/REJECT/INCONCLUSIVE with actionable evidence, exact repros when
possible, and remaining limitations. Write /tmp/ll8-review.md; lead will preserve
its concise result in local teamwork. Full history growth and absence of a real
10-hour run are known limitations, not new scope. Do not spawn other agents.
