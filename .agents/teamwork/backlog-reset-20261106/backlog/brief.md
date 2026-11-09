# Backlog reset worker brief

Owner: root. Scope: rebuild the active development backlog for autonomous
delivery; preserve old development backlog history through a migration map.
Baseline: `ab5c195`.

Owned files:

- `docs/autonomous-delivery-backlog.md`
- `docs/autonomous-delivery-migration.md`
- `.agents/teamwork/backlog-reset-20261106/backlog/brief.md`
- `.agents/teamwork/backlog-reset-20261106/backlog/handoff.md`

The backlog is a plan, not runtime implementation. Its centerpiece is the
executable scenario: account A exhausts, fail over to B, B exhausts, persist the
wait, restart, observe provider-confirmed reset, resume the same objective,
reconcile effects, run mandatory checks, and persist acceptance without owner
continuation. Keep account/context binding, all relevant provider windows,
re-login, owner pause/cancel races, uncertain effects, and truthful incomplete
states explicit. New IDs are independent of archived IDs. No arbitrary counter
may imply completion or create a generic owner question.

The root owns historic banners/index links; another worker owns
`docs/autonomous-delivery-constraints.md`. Do not overlap those paths. Preserve
the distinction between the harness and the orchestrator. No runtime, database,
Git index, commit, push, or unrelated file changes are in scope.
