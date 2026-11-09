# A1 recovery adversarial probes

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane; baseline a34de1e.
Read /home/sr/codex-home/agents/challenger.toml developer_instructions,
transient-recovery/brief.md and final review.md. Do not edit existing source/tests.
Write owned probes in .agents/teamwork/transient-recovery/probes/ or temp and use
only disposable SQLite/HTTP stacks and fake model App Server. No live services,
model calls, target edits, Git changes, or expected-result edits.

Try to break concrete invariants:
1. Owner pause/cancel/shutdown during canResume or in-flight loopback prevents
   automatic continuation, including restart and stale messages.
2. Restart during backoff retains attempts and deadline. Restart of dispatched
   recovery never duplicates active dispatch or bypasses safe decide checkpoint.
3. Unknown writer effects never replay worker/dispatch steps.
4. Failed loopback delivery is bounded and task text/readback reflects new retry
   and exhaustion through actual TaskStore, without clobbering terminal states.
5. Duplicate timers/manual retry/racing sends never dispatch twice.
Prioritize integration gaps; module tests already exercise basic fake-clock gates.
Same selected model only. Treat conservative refusal as safe, but report permanent
stalls where eligible recovery was promised. Give minimal repros and clear
HOLDS or BREAKS verdict, exact commands, limitations and probe artifacts.
Write .agents/teamwork/transient-recovery/challenge.md.
