# M2 acceptance record

Date: 2026-09-30. Candidate: uncommitted working tree on `feature/dashboard-integration`
(base a6f2687). Decisions: [implementation.md](implementation.md). Evidence uses the fake Codex
protocol dev harness (`npm run dashboard:dev`); M2 paths make no A2A or model calls.

## Exit gate

Gate: a direct ticket and its files survive reload/restart, retain references, and do not
start execution until explicitly submitted. Repeated submission does not duplicate the
ticket or run; validation errors remain actionable.

| Item | Result | Evidence |
| --- | --- | --- |
| Create with content, references, attachments | pass | UI create with 2 criteria, priority high, specialty, one reference per category, md+png+pdf; `.html` rejected per file; card Backlog "Draft r1", 3 attachments |
| Detail and downloads | pass | references "not retrieved"; three extraction wordings; downloads `attachment`, sha256 equal to originals and metadata |
| Immutable revisions | pass | edit -> r2 (title changed, pdf dropped); r1 view still shows the old title and the pdf |
| Stale edit | pass | API edit to r3 while the form was open at v2 -> "This ticket changed since you opened it"; reload pulls r3 |
| Actionable validation | pass | 201-char title and 21 links -> field-level errors; form stays editable |
| Idempotent retry | pass | same commandId replay -> 200 `replayed:true`, one card; same id different payload -> 409 `conflict` |
| Cancel | pass | confirm -> Closed "Cancelled"; edit and other actions disabled with reason |
| Reload and restart | pass | tickets, 3 revisions, files (sha match), references and session intact; no new backup on second start |
| No execution | pass | `tasks` 11 and `dispatch_journal` 5 unchanged across all ticket commands; they changed only after a separate legacy `npm run ask` |
| Submit unavailable | pass | "Submit to Intake" visible and disabled, "Intake arrives in M3" |
| M1 regression | pass | legacy run cards render and open their M1 detail; new CLI run completes |
| Console, tests, reference | pass | no CSP violations; only triggered 4xx and a favicon 404; `npm test` 418/418; reference manifest OK |

The final audit fixes (below) were verified by tests and a dev-server boot, not by a second
browser pass.

## Independent audit

Read-only audit found no blocker or major defects. Fixed: backup file created 0600 before
copying; no backup for a fresh install (A2A bookkeeping tables excluded from the emptiness
check); orphan/temp file sweep at startup; staged GC before each upload; staging cap of 50
files / 100 MiB (409 `staging_limit`); bidi controls stripped from display names; existing
loose artifact roots refused instead of chmod'ed; ticket JSON limit raised to 1 MiB; accurate
truncation wording; client criteria length rule matches the server.

## Accepted limits

- Upload hashing, UTF-8 decoding and fsync of files up to 10 MiB run synchronously and can stall
  other requests briefly. Accepted for a local single-operator server.
- `artifact_staged` events carry no ticket id (an upload precedes its ticket); the artifact id is
  in `causationId`, so these events do not appear in a ticket's event list.
- Extracted text is not persisted; it is re-derived from stored bytes by M3 Intake.
- Images are stored but not passed to agents until a model-input adapter is verified.
  PDF/DOC/DOCX are reference-only.
- References are never fetched in M2; Jira/Confluence retrieval is M6.
