# A2 local adversarial probes

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane; baseline2a9f65a.
Read /home/sr/codex-home/agents/challenger.toml developer_instructions,
this task's brief-worker.md and review.md. No existing source/test edits.
Own scratch probes in this task's probes/ or temp only. Disposable SQLite/fake
provider stacks allowed, no live app/model/CI/target/Git effects.

After critic approval, probe concrete invariants efficiently:
- Preflight executes no workspace command, preserves strict route and does not
  promote permissions. Unknown API/dependency errors never become test success.
- Pending/failed policy read is bounded and canceled without late dispatch;
  changed account/generation/policy invalidates cached route scope.
- cwd/PATH executable lookup refreshes after repair, remains filesystem-only.
- Different candidates keep route but need fresh acceptance evidence; no old
  receipt becomes a new pass.
- Explicit/default/free-form owner answers retain truthful choice provenance and
  useful scoped context within digest bounds; defer/outside_run and access/spend
  are not auto-granted after restart/followup/thread rollover.
Prioritize a few integration probes over repeating unit suites. Give minimal
repros for material defects and clear HOLDS/BREAKS with exact commands/limits.
Write challenge.md. Root owns full suite; prior full1410total1401pass8baseline
failures1skip. No need broad rerun.
