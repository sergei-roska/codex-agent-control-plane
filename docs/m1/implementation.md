# M1 implementation decisions

Date: 2026-09-30. Status: complete; evidence in [acceptance.md](acceptance.md). Scope: [backlog M1-01..M1-07](../m0/backlog.md),
contracts in [contracts.md](../m0/contracts.md#m1-read-interface-and-legacy-compatibility).
These are lead decisions; workers implement them and do not re-decide them.

## Module layout

| Module | Backlog | Owner wave |
| --- | --- | --- |
| `src/dashboard-auth.js` | M1-01 pairing, sessions, Host/Origin guard | wave 1 |
| `src/dashboard-projection.js` | M1-02 read-only legacy-run projection | wave 1 |
| `src/event-journal.js` + runtime hooks | M1-04 diagnostic event journal | wave 1 |
| `src/dashboard-api.js` + `src/server.js` mount | M1-03 endpoints, static serving | wave 2 |
| `web/dashboard/**` | M1-05/M1-06 client, board, detail | wave 2 |
| acceptance | M1-07 | wave 3 |

## D-M1-1 Browser authentication (M1-01)

- The A2A bearer token is never shipped to or accepted from the browser path. Dashboard
  API routes accept only a dashboard session cookie; A2A routes keep bearer-only auth.
- Pairing code: 32 random bytes, base64url. Stored only as sha256 in memory, TTL 10 min,
  single use, at most 5 outstanding codes (oldest evicted). A restart invalidates codes.
- Issuance: at startup the server prints `Dashboard pairing URL: http://127.0.0.1:<port>/dashboard/#pair=<code>`
  to stdout. `POST /api/dashboard/v1/pairing-codes` authenticated with the A2A bearer
  issues a fresh code (for `npm run dashboard:pair`). The code travels in the URL fragment,
  so it never reaches server logs or Referer.
- Exchange: `POST /api/dashboard/v1/session` with JSON `{ "code": "..." }` creates a session.
  Session token: 32 random bytes base64url; stored in SQLite table `dashboard_sessions`
  as sha256 (`session_hash TEXT PRIMARY KEY, created_at TEXT, expires_at TEXT, last_seen_at TEXT`).
  Absolute lifetime 7 days, no sliding extension. Sessions survive server restart.
  `DELETE /api/dashboard/v1/session` revokes the current session. Expired rows are purged at startup.
- Cookie: `cacp_session_<port>`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`. No `Secure`
  flag (plain http on loopback). No token in JS-readable storage. Cookies are not port-scoped,
  so the port suffix only prevents two instances overwriting each other; other loopback servers
  of the same OS user can still receive the cookie. Accepted: such processes can already read
  the state database and the A2A token file, so this is not a new trust boundary.
- Host guard on all `/dashboard` and `/api/dashboard` routes: `Host` must be exactly
  `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding defence), else 421-style 403.
- Origin guard on every non-GET dashboard API request: `Origin` must equal
  `http://127.0.0.1:<port>` or `http://localhost:<port>`; missing Origin is rejected.
- Rate limit: session exchange max 10 attempts per rolling minute per process; excess gets 429.
- Static responses set `Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. API responses add
  `Cache-Control: no-store`.
- Static dashboard assets are served without a session (they contain no private data);
  every `/api/dashboard/v1/*` read requires a valid session (401 `unauthorized` otherwise).

## D-M1-2 Legacy-run projection (M1-02)

- Card sources: rows of the SDK `tasks` table. `owner='orchestrator'` rows are root run cards
  (`primaryRole='orch-lead'`). Specialist rows (`owner` = role id) whose `id` appears as
  `dispatch_journal.task_id` are children of that journal row's `run_id` and are not cards.
  Other specialist rows are standalone cards (`cardKind='standalone_execution'`, `primaryRole` = owner).
- `cardId` is opaque: `lr_` + base64url(`namespace` + "\u0000" + `tenant` + "\u0000" + `taskId`).
  Decoding validates namespace against the known set (orchestrator + loaded role ids).
- `title`: first non-empty user text message, whitespace-collapsed, max 200 chars; fallback
  `"(no goal text)"`. Never derived from agent output.
- Column mapping follows the contract table. `input_required` `waitReason` from
  `metadata.pause.kind`: human_decision->human_decision, waiting_for_budget->budget,
  restart->restart, writer_unresolved->writer_unresolved, error->execution_error, other->unknown.
  Unknown A2A states -> needs_attention with `executionStatus='unknown'` and the raw state.
  Backlog column is always empty for legacy cards (no product tickets until M2).
- `acceptance`: from the result artifact metadata `acceptance` (`disposition`, `reasons`), else null.
  `humanReview` is always `"unknown"` for legacy cards.
- Performance: read light columns (`tenant, owner, id, status_state, status_last_updated,
  length(history), length(metadata), length(artifacts)`) for all rows each request; parse
  heavy JSON only for rows whose light tuple changed, via an in-process summary cache.
  Filter, count, sort (`updatedAt` desc, `cardId` desc) and paginate in memory.
- Reads are SELECT-only prepared statements on the shared handle; no DDL, no writes,
  no migrations, no A2A or model calls.

## D-M1-3 Diagnostic event journal (M1-04)

- Table `runtime_events`: `sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  occurred_at TEXT NOT NULL, type TEXT NOT NULL, run_id TEXT, namespace TEXT, task_id TEXT,
  attempt_id TEXT, role TEXT, causation_id TEXT, payload_json TEXT NOT NULL`, index on
  `(run_id, sequence)` and `(task_id, sequence)`. Created at startup, not from GET handlers.
- Types (initial set): `server_started`, `task_reconciled_interrupted`, `writer_reconciled`,
  `run_submitted`, `run_resumed`, `dispatch_submitting`, `dispatch_submitted`,
  `dispatch_finished`, `run_paused`, `run_completed`, `run_failed`, `run_canceled`, `run_error`.
- Payload is sanitized and bounded: allow-listed fields only, strings truncated to 500 chars,
  JSON max 4 KB. Never goal text, prompts, model output, tokens, cookies, env or paths
  outside the workspace. Error events carry `errorName` and a truncated message only.
- `record()` never throws. Failures increment an in-memory counter surfaced as
  `health.eventJournal = { status: 'ok'|'degraded', failures, lastFailureAt }`.
  The journal is diagnostic; lifecycle authority stays in tasks/checkpoints/journal.

## D-M1-4 Read API (M1-03)

All responses JSON. Errors: `{ "error": { "code", "message", "requestId", "details"? } }`,
codes `unauthorized`(401), `forbidden`(403), `not_found`(404), `invalid_request`(400),
`rate_limited`(429), `unavailable`(503). No stack traces or credentials.

- `GET /context` -> `{ apiVersion: 1, project: { projectId, displayName, workspace },
  server: { version, startedAt, now }, capabilities: { mutations: false, liveStream: false,
  events: true }, health: { eventJournal }, lastEventSequence }`.
  `projectId` = `prj_` + first 16 hex of sha256(realpath(workspace)); displayName = basename.
- `GET /roles` -> `{ roles: [{ id, displayName, description, sandbox, model, effort, kind: 'lead'|'specialist' }] }`.
- `GET /cards?column=&role=&q=&limit=&cursor=` -> `{ cards: [Card], counts: { backlog, pending,
  in_progress, needs_attention, closed }, roleCounts: { [roleId]: n }, nextCursor: string|null,
  snapshotAt }`. `limit` default 50, max 100. `column` one of the five; `role` a known role id
  (matches `participatingRoles`); `q` max 200 chars, case-insensitive substring of title or taskId.
  `counts` reflect `role`/`q` filters but not `column`; `roleCounts` ignore all filters.
- Card: `{ cardId, cardKind: 'legacy_run'|'standalone_execution', runtimeTaskRef: { namespace,
  tenant, taskId, contextId }, projectId, ticketId: null, title, boardColumn, executionStatus,
  displayStatus, rawState, acceptance: { disposition, reasons } | null, humanReview: 'unknown',
  waitReason: string|null, primaryRole, participatingRoles: [roleId], attemptCount,
  createdAt: string|null, updatedAt }`.
- `GET /cards/:cardId` -> `{ card, statusMessage: string|null (max 4000), pause: sanitized|null,
  resultText: string|null (max 20000), userMessages: [{ text (max 4000), at|null }],
  availableActions: [], unavailableActions: [{ action, reason, milestone }] }`.
  `action` is exactly one of `pause`, `resume`, `stop`, `cancel`, `edit`, `return_to_backlog`,
  `review`, `commit`, `push`; the UI matches by exact name.
- `GET /cards/:cardId/attempts` -> `{ attempts: [{ attemptId, assignmentId, role, sandbox,
  journalState, runtimeTaskRef|null, taskState|null, outcome|null, createdAt, updatedAt }] }`
  from `dispatch_journal` ordered by `created_at, rowid`; empty for standalone cards.
- `GET /cards/:cardId/usage` -> the existing `usage-report.js` `buildReport` summary for the
  run (lead) or task (standalone), with unknown values null and a `coverage` field; never zero-filled.
- `GET /cards/:cardId/events?after=&limit=` -> `{ events: [...], nextAfter }` from `runtime_events`.
  `nextAfter` is the last returned sequence (or `after` when empty); a page shorter than
  `limit` means no more events at snapshot time.

Polling client: 3 s while visible, pause when hidden, back off to 30 s after 3 consecutive
failures, abort stale requests, show last successful snapshot time. 401 shows the pairing screen.

## Verification rule

Every wave report is checked against the actual diff. Reference integrity is checked with
`sha256sum -c docs/m0/reference-integrity.sha256.txt` at each wave.
