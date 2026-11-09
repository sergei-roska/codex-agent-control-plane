# Constraint inventory handoff

Status: complete. Baseline `ab5c195`; source and documentation only.

Created `docs/autonomous-delivery-constraints.md`. It covers AD-01 through AD-06
and relevant AD-05 integrity constraints, with source evidence, verdicts and
acceptance probes. Decisive findings were sent to root and the backlog worker.

Important distinction: the server budget watcher routes mapped runs through
`DeliveryEngineRouter`, including concurrent runs. Concurrent auto-failover still
has a source gap: lifecycle budget eligibility is not wired, provider pins reject
in-process account drift, and restart rebind eligibility excludes `waiting_budget`.
Safe rebind must retain effect settlement and durable identity changes.

The server's legacy orchestrator uses `maxRounds=80` by constructor default
because its factory call supplies no override; the historical `Current behavior`
section in `docs/codex-handoff.md` conflicts. Runner and local 90-percent dispatch
thresholds are nonportable development controls, not product limits. Unresolved
work cannot become terminal partial merely because a heuristic fired; terminal
partial requires an owner-authorized scope/end decision.

Verification: bounded source and caller inspection only; no tests or live provider
actions run. Next: backlog worker links this inventory; root integrates stale entry
points and obtains independent review.
