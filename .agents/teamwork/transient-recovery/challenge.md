# A1 transient recovery adversarial result

Verdict: HOLDS

The previously confirmed restart failure is fixed. The executor now requires
`autoResume === true` before accepting a transient automatic message. The
recovery object also requires the message's attempt and checkpoint ID to match
the durable `dispatched` record.

## Probes run

- `.agents/teamwork/transient-recovery/probes/disabled-stale-retry.cjs` persists
  a `dispatched` retry, simulates a restart with automatic recovery disabled,
  and delivers a stale automatic message. Result: zero resume calls, task
  remains `INPUT_REQUIRED`. Command:
  `node .agents/teamwork/transient-recovery/probes/disabled-stale-retry.cjs`
- `.agents/teamwork/transient-recovery/probes/stale-identity-retry.cjs` keeps
  automatic recovery enabled but delivers an automatic message with an older
  attempt and different checkpoint ID than the durable `dispatched` record.
  Result: zero resume calls, task remains `INPUT_REQUIRED`. Command:
  `node .agents/teamwork/transient-recovery/probes/stale-identity-retry.cjs`

Both commands exited zero. The first probe uses a real SQLite recovery store
and executor with a fake orchestrator. The second uses the same boundary. No
live HTTP transport, model, or target task was used. The worker separately
reported 113/113 affected regression tests passing; this challenge did not
rerun that suite.

The probes cover the previously broken setting boundary and one stale message
identity case. They do not establish every possible HTTP delivery or process
crash ordering.

Status: complete
Scope expansion: none
