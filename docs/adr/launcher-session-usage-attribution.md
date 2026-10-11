# ADR: Session token usage attribution in the launcher

Status: accepted 2026-10-11. Implemented in `bd986be`.

## Decision

`GET /api/projects/:id/sessions/:contextId/usage` attributes `usage_ledger`
rows to a session through its lead turns, not through `context_id`:

- lead rows (`kind = lead_turn`) are keyed by `run_id` = lead task id;
- worker rows (`kind = worker_turn`) carry a per-attempt context id and reach a
  session only through `dispatch_journal` (`run_id` = lead task id), joined by
  task id and, for lost submissions, by context id (`UsageLedger.listByRun`);
- rows are deduplicated by `entry_id`;
- legacy lead rows recorded as `orch-lead` fold into the current lead role
  (`LEAD_ROLE_NAME`) so old sessions show lead usage on the lead card.

The session's lead task ids come from the shared `sessionLeadTaskIds`
(`src/launcher-sessions.js`), the same rule `getSession` uses.

## Alternatives considered

- Filter by `usage_ledger.context_id`: rejected; worker rows never carry the
  session context id, so worker usage would be missing.
- Store a session id on every ledger row: rejected for now; needs a schema
  change and a backfill, while the journal join already covers all rows
  (verified: sum over sessions equals total rows on a real DB).

## Consequences

- Standalone scout asks (no dispatch_journal row) are not counted in session
  usage; showing them needs a separate scope.
- The attribution depends on `dispatch_journal`; a future change to the journal
  must keep the run-id link.
