# CN15 matched legacy/concurrent scheduling qualification

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read/apply
/home/sr/codex-home/agents/senior_worker.toml developer instructions and
/home/sr/codex-home/development-access.md. Root owns Git/docs. Allowed product
writes ONLY a new test/concurrent-engine-comparison.test.js (or a new test helper
owned by you if needed; report its path before adding). Evidence and handoff.md
under .agents/teamwork/cn15-comparison-20261028/. No edits to current source/tests,
Git mutation, live provider calls, existing services, account/settings or installs.
Existing Node CommonJS dependencies; disposable local HTTP/Git/SQLite test fixtures
are allowed. All authored content ASCII English. No quota notes.

Close missing offline V41 in ../cn14-facade-20261028/cn15-coverage.md, supported by
docs/architecture/concurrent-harness/validation.md V41 and implementation-plan.md
CN15. Inspect actual legacy and concurrent server/engine fixtures in
test/server-delivery-engine.test.js, test/concurrent-delivery-engine.test.js,
test/lead-graph.test.js and current code. Preserve independent legacy behavior.

Build a matched deterministic fixture through both actual execution paths using
fake providers/transport, same frozen task content/DAG, controlled duration/barrier
schedule and equivalent mandatory acceptance checks. Record causal start/finish
ordering and peak worker concurrency. Demonstrate dependency progress while a
slow sibling remains live, new throughput overlap and accepted output equality.
Require real legacy/concurrent completion with authoritative acceptance results,
not just mocked scheduler counters or comparing hand-authored strings. Account
for legitimate contract/API differences while keeping task/check payloads equal.
Use barriers/native promises instead of speed assertions based on wall time.
If prerequisite runtime behavior blocks decisive comparison, report exact repro
and recommended bounded scope rather than edit source or weaken the goal.

Acceptance: retained offline fixture proves V41 causal scheduling comparison and
identical accepted product/check output through both real paths; independent
review/challenge later. Do not claim actual provider speedup/cost/quality or live
qualification. Run focused new file and necessary existing related checks only;
root runs frozen broad verification after source milestones settle. Another worker
may modify terminal-recovery source but owns no comparison files. Root may update
durable docs after your final report.

Never run prohibited hostile Git-filter test:
candidate attributes and inherited Git configuration cannot execute filters while mirroring
Any full/delivery-acceptance run requires exact skip pattern from predecessor.
Keep brief.md/handoff.md current; report concise findings, exact checks, changed
files, limits, Status and Scope expansion. Send decisive blockers promptly and
continue independent work. User wants entire plan advanced without confirmations.
