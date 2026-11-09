# A3/A4 adversarial checks

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Baseline576fbdf.
Read /home/sr/codex-home/agents/challenger.toml developer_instructions,
this task's brief-worker.md and final review.md. No existing source/test edits;
owned scratch probes only. Fake provider/disposable DB; no live app/model/target.

Prioritize concrete state-machine counterexamples after critic approval:
- Three invalid outputs, then capacity/quota failure during fresh planning,
  restart/automatic resume, then another invalid output: must stop partial with
  no new correction/fresh allowance and zero invalid dispatch. Use actual server
  automatic-origin wiring where feasible, not just a hand-set runtime flag.
- A manual pause requested during final invalid or repeated unmet-goal turn
  prevents acceptance until explicit owner resume; cancel/stop remains honored.
- Final technical partial runs acceptance once even if checks fail/change,
  cannot re-enter planning/repair, and does not count stale/unreviewed/unknown
  or owner-blocked checkpoints as accepted.
- Repeated investigated false finish with local fixable cause cannot ask owner;
  genuine typed owner question still parks; old persisted owner escalation
  remains manually resumable. Fresh planning retains scoped owner/review context.
Form a small number of minimal probes beyond existing tests; report HOLDS/BREAKS
with exact repros, commands/results, uncertainty and artifacts in challenge.md.
Root owns full suite/Git. Do not broaden into live measurements or unrelated bugs.
