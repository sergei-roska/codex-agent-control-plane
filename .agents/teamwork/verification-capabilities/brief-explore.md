# A2 execution capability and persistent owner decisions

Cwd: /home/sr/Projects/Workspace/codex-agent-control-plane. Baseline2a9f65a,
clean tree. Read /home/sr/codex-home/agents/explorer.toml developer_instructions,
AGENTS.md, docs/harness-autonomy-audit-2026-10-21.md A2, and
.agents/teamwork/transient-recovery/next.md. English/ASCII artifacts only.

Goal: ground a minimal cohesive A2 implementation plan. Find existing execution
capability preflight, owner environment/verification decisions and persistence,
acceptance route config and target binding. Inspect src/project-settings.js,
execution-permissions.js, acceptance.js, lead-graph.js, lead-orchestrator.js,
contracts.js and relevant tests as needed. HAR-03 native permissions already fixed
historical sandbox mismatch; do not propose another bypass.

Report: concrete remaining code gaps, exact extension points, and recommended
bounded acceptance criteria for reusable verification-route authorization separate
from fresh candidate-bound evidence. Distinguish product-scope owner decisions
from internal environment work. Identify safe preflight that does not execute
untrusted/project commands or require new external CI/spending authorization.
Recommend architecture compatible with existing durable state and backwards
compatibility. Do not implement or overdesign; root chooses final scope.

Write handoff.md in this task directory. Source read-only; own scratch only.
No launcher/project service start/restart, live tasks, provider/model turns,
external messages/writes, target edits or Git mutations. App stays owner-stopped.
Fresh native quota:100% five-hour,54% weekly remaining.
