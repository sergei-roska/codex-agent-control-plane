# ADR: Owner questions go to the scout role, bypassing the lead

Status: accepted 2026-10-11. Implemented in `1bd5823`, reviewed (Opus,
APPROVE). Design: `docs/session-situation-design.md` (SIT-5).

## Decision

The owner can ask questions at any time, including while a lead task runs.
The launcher sends each question as one plain-text A2A message straight to the
project server's `/agents/scout` endpoint with a fresh contextId and the
loopback token; the lead is never messaged or interrupted.

- Role: existing `scout` (gpt-6-luna, medium, sandbox read-only); owner
  decision. Its profile gains an owner-question mode triggered by the first
  line `Owner question:`; read-only rules unchanged.
- The prompt never starts with `{` and has no `objective` / `allowedFiles`
  keys, so `parseStructuredRequest` never treats it as an assignment.
- A bounded data pack (situation + git status, 8192 chars, markers
  neutralized) is passed between `BEGIN DATA` / `END DATA` as data.
- Guards: one ask per project, 5 minute timeout then cancel, 15 s timeout per
  A2A call, project server must be running; asks live in launcher memory
  (last 20 per project) and are dropped when the project is removed.
- The answer uses the existing worker report schema (`summary` plus checks,
  filesInspected, risks).

## Alternatives considered

- Message the running lead (steering): rejected for this purpose; touches the
  lead loop and interrupts its work. Kept as a separate idea (SIT-4).
- A new task type in the project A2A server: rejected; adds code to the lead's
  server for no gain over the existing role endpoint.
- A new dedicated Q&A role: rejected by the owner; reuse `scout`.

## Consequences

- Asks share the project's single app-server child (restart budget 3) and the
  accounts with the lead; the one-ask guard limits the load but turns are not
  serialized.
- Scout usage is recorded (`worker_turn`, role scout, run id null) but not
  shown in session usage (see `launcher-session-usage-attribution.md`).
