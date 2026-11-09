# Durable transient recovery (A1)

Implement A1 from docs/harness-autonomy-audit-2026-10-21.md against baseline a34de1e.
Cwd: /home/sr/Projects/Workspace/codex-agent-control-plane. Node CommonJS, npm test.
Read /home/sr/codex-home/agents/worker.toml developer_instructions before work.
Read AGENTS.md, audit A1, and predecessor handoff autonomy-audit/handoff.md.

Worker owns source/tests needed for A1, and docs describing implemented behavior.
Root owns Git and .agents/teamwork/PROJECT.md. No other source writer active.
No live service restart, task resume, deployment, model turn or target-project edits.
Use disposable test DB/services only. Do not commit. English/ASCII authored files.

Acceptance:
- Structured conservative classification distinguishes capacity, eligible service/transport
  transients, rate limiting, quota, auth/config errors. Unknown failures stay manual.
- Durable bounded backoff with jitter stores attempts, next retry, cause and checkpoint
  identity. Discovery survives server restart, retries use existing resume semantics.
- Keep selected model. Never blindly replay uncertain writers: reconciliation and ownership
  must gate replay; test unknown effects and no duplicate dispatch.
- Explicit owner pause, stop/cancel and auto-resume disabled prevent automatic continuation.
- UI/task text exposes next attempt and exhausted recovery. Avoid new UI scope if existing
  status text suffices.
- Tests: transient then success; restart in backoff; exhaustion; owner stop during wait;
  unknown writer effects; duplicate scheduling; no model fallback; auth/config/quota negatives.
- Preserve HAR-01..04 behavior and existing budget watcher.

Choose cohesive architecture after inspecting current checkpoint and watcher machinery.
Report exact tests/results, files, remaining risks and handoff under this directory.
