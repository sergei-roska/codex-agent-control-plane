# Critical Harness repairs handoff

Status: complete for confirmed repairs, uncommitted working tree.
Baseline: c22528e7f47e2fc954ce7c032d51391baccc309f; initial tree clean.

## Durable record and scope

Findings, exact baseline locations, causes, repairs, and verification are in
`docs/harness-critical-incidents-2026-10-20.md`; HAR-01..04 are registered in
`docs/orchestrator-improvement-backlog.md`. Native policy is specified in
`docs/execution-permissions.md`. README and boundary/lane docs are updated.
Owner explicitly chose configured native Codex permissions for trusted projects.

## Completed

- Lead guidance groups independent disjoint writers into concurrent waves.
  Scheduler already supported overlap; saved assignments mostly used null waves.
- Automatic review recovery retains all six bounded brief fields.
- Recurrence history survives unrelated writes and remains scoped to targets.
- Settled no-progress loops end with an honest bounded partial ledger and one
  final acceptance run, using current integrated receipts, without another
  automatic repair or owner continuation. Unresolved writers and owner pauses
  retain their existing handling.
- Native permissions propagate through Lead/workers/final checks, with strict
  fallback and read-only inspection. Full-access lanes report cooperative mode
  and no confinement. Explicit admitted shared administrative Git routing fixes
  the private-lane commit mismatch; authorized Git role conflicts are removed.
- Launcher persists bounded sanitized startup diagnostics and recognizes only
  exact stdout listener readiness. Quoted JSON secret redaction was repaired
  after the first review rejection.

## Verification

- Independent core and expanded final reviews: APPROVE (review-core.md,
  review-final.md). Workers' handoffs contain focused test commands/results.
- Baseline npm test:1356 total,1344 pass,10 fail,2 skip.
- Final npm test:1385 total,1376 pass,8 fail,1 skip. No new failures; all8
  remaining names reproduce baseline. final-comparison.json and final-full.log
  retain exact evidence. Two stale contract expectations were corrected.
- node --check:25 changed/new JS files pass. git diff --check passes.
- Native App Server0.163 probes, no model turns: inherited loopback acceptance,
  disposable local Git commit, ephemeral settings transitions, and actual
  isolated startServer HTTP200 all pass. Native evidence is saved here.
- Owned servers/workspaces and baseline worktree were cleaned up. Raw local
  evidence is ignored by Git and may disappear; durable results are in docs.

## Limits and practical boundaries

Actual model-generated overlap and long-run convergence have no post-fix live
measurement. The original failed launch cannot be reconstructed from its lost
log; do not claim its exact cause is established. Eight baseline MCP-related
verification failures remain. No live target source/session/acceptance pin/owner
pause was changed, no project service restarted, no commit/push/deploy performed.
No Astra call: confirmed causes found; avoid further work under remaining quota.
Last native quota read2026-10-20T07:56:39.528Z:5 percent five-hour and85 percent
weekly remaining. See final-quota.json. No required implementation work remains.
