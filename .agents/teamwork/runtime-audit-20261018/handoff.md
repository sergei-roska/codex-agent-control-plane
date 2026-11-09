# Handoff: recent Harness runtime audit

Status: complete. Read-only audit of 2026-10-18 16:27-20:57 Europe/Chisinau
(13:27-17:57 UTC). Runtime project `c65886082e`, run
`9e2c8b53-458b-4ccf-924b-ee13639510df`.

## Findings

- `dispatch_journal` contains 57 finished dispatches across 57 assignments and
  57 task IDs. Role counts: verifier 24, explorer 16, auditor 5, engineer 5,
  senior-engineer 5, recovery-engineer 2. No assignment had multiple dispatch
  attempts.
- `live_activity` has 56 role intervals in the window. They have no overlap;
  maximum observed concurrent role count is one. The lead dispatched agents
  strictly in series. Dispatch volume is not evidence of parallel execution.
- `usage_ledger` records 65 coordinator turns totaling 2,400,519 ms (about 40
  minutes; 36.9 seconds average). One verifier interval lasted about 23 minutes
  and ended with a failed review result.
- Task states: 52 completed, 5 failed, and the lead run is
  `TASK_STATE_INPUT_REQUIRED`. Two worker turns ended in `input_error` before
  useful work: one `review_origin_stale`, one with `review_target_unknown`,
  `review_writer_unsettled`, and `concurrent_writer` metadata. These are
  coordination/preflight defects caught by the review gate, not model retries.
- Staging metadata records 17 verifier failures, 4 audit failures, 38 failed
  checks, and 25 checks not run. These counts include review/check outcomes and
  must not be described as 57 failed agent tasks.
- At the end of the window the run was waiting for an owner decision with
  reason `infeasible_requirement` (decision h8). The latest problem records for
  `P-M1-CANDIDATE-BINDING-GAP` and
  `P-M1-REPAIRED-CANDIDATE-EXTERNAL-CI` were open. Nine problem IDs had latest
  status open in the event log; this is tracker state, not proof that all nine
  independently block the current task.
- A `pytest` process (PID 183811) remained alive in the post-window snapshot at
  21:02 local after about 78 minutes, with its cwd deleted, about one second of
  total CPU time, and `ep_poll` wait state. Another (PID 274507) remained alive for
  about 28 minutes in lane `lane-mve3tdvo-c1e6fca4`; it ran selected
  `tests/api/test_server.py` health cases, although the corresponding verifier
  activity had ended at 20:36 local. Both are likely leaked or wedged child
  processes. They were not stopped.

## Verification and limits

- SQLite opened with Python `sqlite3` URI `mode=ro`; window filter was
  `created_at >= '2026-10-18T13:27:00Z'` through `17:57:00Z`.
- Query basis:

  ```sql
  SELECT role, state, COUNT(*), MIN(created_at), MAX(updated_at)
  FROM dispatch_journal
  WHERE created_at >= '2026-10-18T13:27:00Z'
  GROUP BY role, state;

  SELECT role, started_at, COALESCE(ended_at, updated_at)
  FROM live_activity
  WHERE started_at < '2026-10-18T17:57:00Z'
    AND COALESCE(ended_at, updated_at) >= '2026-10-18T13:27:00Z';

  SELECT type, status, COUNT(*)
  FROM staging_events
  WHERE created_at >= '2026-10-18T13:27:00Z'
  GROUP BY type, status;

  SELECT kind, role, outcome, COUNT(*), SUM(elapsed_ms)
  FROM usage_ledger
  WHERE recorded_at >= '2026-10-18T13:27:00Z'
  GROUP BY kind, role, outcome;
  ```

- Concurrency derived from pairwise overlap of `live_activity.started_at` and
  `ended_at` (falling back to `updated_at`).
- Process snapshot command:
  `ps -p 183811,274507 -o pid,stat,etimes,time,%cpu,comm --no-headers`.
- `git status --short --branch` returned `## main`.
- No product files changed.
- No tests were run, no process was stopped, and no runtime state was changed.
- Runtime records are timestamped metadata, not a complete account of every
  shell operation. Long-lived process status is transient and should be
  rechecked before any follow-up action.

## Conclusion

The observed lead did not parallelize agent execution. It used a serial
verification/repair/review cycle with substantial repeated gate failures and
some wasted preflight dispatches. Two persistent pytest processes indicate a
likely process-lifecycle cleanup gap. The run itself is blocked on an owner
decision, with candidate-binding/external-CI blockers still open.
