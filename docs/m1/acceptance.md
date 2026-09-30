# M1 acceptance record

Date: 2026-09-30. Candidate: uncommitted working tree on `feature/dashboard-integration`
(base 2591848). Decisions: [implementation.md](implementation.md). All evidence below uses the
fake Codex protocol (`npm run dashboard:dev`); no live OpenAI model run was performed for M1.

## Exit gate

| Gate item | Result | Evidence |
| --- | --- | --- |
| Unpaired access | pass | `/dashboard/` shows the Not paired panel; `GET /api/dashboard/v1/context` returns 401 |
| Pairing | pass | `#pair=` code exchanged, hash stripped, header shows project and connected state; bad code shows "Invalid or expired pairing code" |
| CLI run appears and progresses | pass | `npm run ask` run with `DASHBOARD_DEV_TURN_DELAY_MS=8000`: In Progress (orch-lead, then orch-explorer) -> Closed "Completed" without reload |
| Detail | pass | goal text, orch-explorer attempt as a child (not a card), events run_submitted/dispatch_*/run_completed, usage unavailable/partial (never 0), acceptance not_required, "Human review: unknown", 9 mutation controls disabled with reasons |
| Browser reload | pass | session and cards persist; reload during In Progress keeps the column |
| Server restart | pass | session survives restart without re-pairing; history retained; `server_started` recorded; SIGKILL mid-run -> Needs Attention "Waiting: restart" with `task_reconciled_interrupted` |
| Honest states | pass | fresh state shows 0 executions; exhausted fake script -> Needs Attention `execution_error` |
| No side effects from observation | pass | tasks 8, dispatch_journal 4, usage_ledger 12, runtime_events 22 unchanged after 60 s of an open board |
| Console/CSP | pass | no JS errors or CSP violations; expected 401 before pairing; unidentified 404s (likely favicon) |
| Regression and reference | pass | `npm test` 359/359; `sha256sum -c docs/m0/reference-integrity.sha256.txt` OK |

## Independent audit

Read-only audit of the diff: no critical/high findings. Fixed: per-port session cookie name,
child detection by `context_id` for lost submissions, 400 for malformed percent-encoding,
usage coverage accounting for attempts without usage rows, pairing failure message kept visible.
Accepted as documented: `run_error` stores a truncated error message (see D-M1-3).

## Known limits carried forward

- The Pending column was not observed; the lead run moves to working immediately after submission.
- `createdAt` and user message timestamps are unavailable in stored A2A data and render as unavailable.
- Sidebar role counts are totals, not split by status. Role-lane counts are "loaded" counts when truncated.
- Pipelines, Monitor, Decisions, Docs and Connections remain prototype previews with a sample-data banner (M4-M8).
- Mutations (ticket creation, operator commands) are unavailable by design until M2/M7.
