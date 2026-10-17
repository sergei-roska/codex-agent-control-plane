# AUT-03 cohort 2 turn-cap stop

On 2026-10-17, the skill-on `bounded-dependencies` task in cohort 2 attempted a
fourth `turn/start`. The pinned cap of three was enforced before the request was
sent. The dedicated trial process stopped, and the client ended with `fetch
failed` after the process shutdown. The task is incomplete and excluded.

Evidence is under
`live-trial/cohort-2/skill-on/bounded-dependencies/`:

- Task ID: `425da1ec-90c5-4a34-b60c-4d75f48d88ab`.
- Three `turn/start` submissions completed; a fourth was attempted and blocked.
- The usage ledger contains three completed turns and one aborted row, with
  74,010 measured total tokens across the completed turns.
- No worker dispatch, writer execution, permission event, command, or workspace
  mutation occurred. The workspace remained empty and read-only.
- The preflight and post-task evidence report the pinned system Team account,
  automatic account switching disabled, and no provider quota-exhaustion error.
- The resulting `TASK_STATE_INPUT_REQUIRED` task was not resumed.

Cohort 2 is excluded as a whole. Its four skill-off outputs were frozen, and its
skill-on `pilot-price-f2` completed, but the skill-on arm did not complete all
four paired cases. Preserve the baseline freeze and all task artifacts as
historical evidence; do not score or reuse them.

The next protocol revision raises the per-task `turn/start` cap to eight while
retaining the 240-second task timeout and token budgets. The trial gate stays
closed until independent review approves the revised declaration, runtime pin,
helper, and evidence pointers. The fresh paired cohort must begin again with
skill-off `pilot-price-f2`.
