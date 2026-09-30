# M2 implementation decisions

Date: 2026-09-30. Status: complete; evidence in [acceptance.md](acceptance.md). Scope: [beta plan M2](../beta-master-plan.md#m2-store-direct-requests),
contracts in [contracts.md](../m0/contracts.md), limits in
[decisions.md, Attachments and limits](../m0/decisions.md#attachments-and-limits).
M1 surfaces this builds on: [M1 decisions](../m1/implementation.md). Lead decisions; workers
implement them and do not re-decide them.

## Scope boundary

- Commands in M2: Create (backlog draft), Edit draft (new immutable revision), Cancel
  (backlog ticket with no run -> cancelled). Nothing else changes ticket status in M2.
- Submit to Intake is visible but unavailable ("Intake arrives in M3"). No run is created,
  no A2A call, no model call from any M2 path. "Repeated submission" in the M2 gate means
  retrying a create/edit command: the same `commandId` never duplicates a ticket or revision.
- Allowed manual transitions in M2: `backlog -> backlog` (edit), `backlog -> cancelled`.
  No drag/drop transitions. No reopen.
- References (Jira issue, Jira parents, Confluence, Figma, other links) are stored as
  unretrieved source references. The server never fetches them in M2.

## Module layout

| Module | Responsibility | Wave |
| --- | --- | --- |
| `src/product-migrations.js` | versioned product schema migrations with pre-migration backup | 1 |
| `src/product-store.js` | tickets, revisions, artifact rows, commands, idempotency, validation | 1 |
| `src/artifact-store.js` | file bytes on disk, type validation, text extraction, staged GC | 1 |
| `src/dashboard-api.js`, `src/dashboard-projection.js`, `src/server.js` | HTTP commands/reads, board merge, events | 2 |
| `web/dashboard/**` | create/edit form, ticket detail, attachments UI | 2 |

## D-M2-1 Schema and migrations

- Migration ledger `product_schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL,
  applied_at TEXT NOT NULL)`. Migrations are an ordered in-code list; each applies in one
  transaction. Applied at server startup only, never from request handlers.
- Before applying any pending migration to a file database that already has a ledger or
  any existing table, write a backup with better-sqlite3 `db.backup()` to
  `<state file>.bak-v<currentVersion>-<UTC yyyymmddTHHMMSSZ>` (mode 0600). No backup for
  `:memory:` or a brand-new empty file. Backup failure aborts startup before migrating.
- A database whose ledger has a version newer than the code knows aborts startup with a
  clear error (no downgrade).
- Migration 1 `product_tickets` creates:

```sql
CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL,
  title TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL,
  current_revision_id TEXT NOT NULL, version INTEGER NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL
);
CREATE INDEX tickets_updated_idx ON tickets (updated_at, ticket_id);
CREATE TABLE requirement_revisions (
  revision_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id),
  parent_revision_id TEXT, ordinal INTEGER NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, criteria_json TEXT NOT NULL, references_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL, priority TEXT NOT NULL, tracking_mode TEXT NOT NULL,
  requested_specialty TEXT, actor TEXT NOT NULL, command_id TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (ticket_id, ordinal)
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY, ticket_id TEXT REFERENCES tickets(ticket_id),
  state TEXT NOT NULL, kind TEXT NOT NULL, media_type TEXT NOT NULL, display_name TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_ref TEXT NOT NULL,
  extraction TEXT NOT NULL, extracted_chars INTEGER, extraction_truncated INTEGER NOT NULL,
  origin TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE product_commands (
  command_id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
```

- `runtime_events` gains a nullable `ticket_id` column (idempotent column check in
  `EventJournal.ensureSchema`, like `dispatch_journal.objective_sha256`), plus event types
  `ticket_created`, `ticket_revised`, `ticket_cancelled`, `artifact_staged`. Payloads carry IDs,
  ordinal, counts and sizes only; never titles, descriptions, filenames or file content.

## D-M2-2 Identity and values

- IDs: `tkt_` / `rev_` / `art_` + 16 random bytes base64url. Backend-generated only.
- `source='direct'`, `tracking_mode='internal'`, `created_by`/`actor='operator'` (single paired operator).
- `priority` in `low|normal|high`, default `normal`. Ticket `status` in M2: `backlog|cancelled`.
- `requested_specialty`: null or one of `project-manager, architect, developer, qa, reviewer,
  security, performance, devops, tech-writer` (ids from [roles-tools.md](../m0/roles-tools.md)).
  It is a preference only; it assigns nothing.
- Revision content: `title` 1..200 chars after trim; `description` <= 32,000; `criteria` array of
  non-empty strings, joined length <= 16,000, max 100 items; `references` object with arrays
  `jiraIssues, jiraParents, confluence, figma, links`, each <= 20 items, each item a string of
  1..2,000 chars, stored as `{ value, availability: 'not_retrieved' }`; `artifactIds` <= 10.
  Unknown fields are rejected. Strings are stored as given (no HTML processing); control
  characters other than tab/newline are rejected.
- `tickets.title`/`priority` mirror the current revision, updated in the same transaction.
- `version` starts at 1, increments on every successful command on the ticket.

## D-M2-3 Commands

Every command body carries `commandId` (client-generated UUID, 8..100 chars `[A-Za-z0-9_-]`).
Idempotency: `payload_sha256` = sha256 of canonical JSON of the command kind, target ticket and
body without `commandId`. Same id + same hash returns the stored result with HTTP 200 and
`replayed: true`; same id + different hash -> 409 `conflict`. The ledger row, ticket rows,
revision rows and artifact ownership update commit in one transaction.

| Command | Preconditions | Effect |
| --- | --- | --- |
| create | valid content; every artifact id is `staged` | ticket (backlog, v1) + revision ordinal 1; artifacts -> `attached`, `ticket_id` set |
| revise | `expectedVersion` = current; status backlog; artifacts staged or already attached to this ticket | revision ordinal n+1 with `parent_revision_id`; pointer/mirror/version update; newly referenced staged artifacts attached |
| cancel | `expectedVersion` = current; status backlog | status cancelled; version+1; revisions and artifacts retained |

Errors: `invalid_request` (400, with `details: [{ field, message }]`), `not_found` (404),
`stale_version` (409, `details.currentVersion`), `conflict` (409), `invalid_state` (409).
Per-ticket file limits (10 files, 25 MiB combined over the revision's `artifactIds`) are checked
at create/revise.

## D-M2-4 Attachments

- Storage root: `<dirname(state file)>/artifacts` (env `CODEX_A2A_ARTIFACT_DIR` overrides),
  dir 0700, files 0600 at `<root>/<first 2 chars after prefix>/<artifact_id>`; written to a temp
  file in the same dir, fsynced, renamed. The storage path is built from the artifact id only;
  the client filename is never used in a path. `:memory:` state uses a temp dir.
- Upload: `POST /api/dashboard/v1/artifacts` with the raw file as body (`express.raw`, limit
  10 MiB, any content type), header `X-Filename` (percent-encoded UTF-8, required).
  Display name: decoded, path components stripped, control chars removed, <= 255 chars.
- Format matrix (extension decides the class; content must match):

| Extensions | Content check | Stored media type | `extraction` |
| --- | --- | --- | --- |
| .txt .md .json | valid UTF-8 (fatal decoder); .json must parse | text/plain, text/markdown, application/json | `extracted` (first 100,000 chars; `extraction_truncated` flag) |
| .png .jpg .jpeg .webp | magic bytes | image/png, image/jpeg, image/webp | `stored_not_read` (no verified model-input adapter yet) |
| .pdf .doc .docx | `%PDF-`, OLE `D0CF11E0`, ZIP `PK\x03\x04` | application/pdf, application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document | `reference_only` |
| anything else | - | - | rejected, 415 `unsupported_media_type` |

- Response: artifact metadata `{ artifactId, displayName, mediaType, size, sha256, extraction,
  extractedChars, extractionTruncated, state: 'staged', createdAt }`.
- Download: `GET /api/dashboard/v1/artifacts/:artifactId/content`, session required, always
  `Content-Disposition: attachment` with RFC 5987 filename, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'`, text types served as-is with their
  stored type plus `; charset=utf-8`. Staged artifacts are downloadable (preview before save).
- Metadata: `GET /api/dashboard/v1/artifacts/:artifactId`.
- Staged artifacts older than 24 h are deleted (row and file) at startup. Attached artifacts are
  never deleted by M2 code, even when a later revision drops them.
- UI wording: `extracted` = "Text available to agents after Intake (M3)"; `stored_not_read` =
  "Stored; agents cannot read images yet"; `reference_only` = "Stored as reference; content is not read".

## D-M2-5 API and board

All mutating routes: session + `originGuard` + JSON body limit 256 KiB (uploads excepted).

- `POST /tickets` (create), `POST /tickets/:ticketId/revisions` (revise),
  `POST /tickets/:ticketId/cancel`. Success: `201` (`200` on replay) `{ ticket, revision, replayed }`.
- `GET /tickets/:ticketId` -> `{ ticket, revision, revisions: [{ revisionId, ordinal, createdAt,
  actor, parentRevisionId }], artifacts: [metadata], availableActions, unavailableActions }`.
  Backlog: available `edit`, `cancel`; unavailable `submit` (reason "Intake arrives in M3",
  milestone "M3") plus the M1 list minus `edit`/`cancel`. Cancelled: no available actions.
- `GET /tickets/:ticketId/revisions/:revisionId` -> full revision with artifact metadata.
- `GET /context` adds `capabilities.mutations: true`, `capabilities.ticketCommands:
  ['create','revise','cancel']`, `requestedSpecialties: [{ id, displayName }]`,
  `attachmentPolicy` (the matrix and limits above), `trackingMode: 'internal'`.
- `/cards` merges tickets as `cardKind: 'ticket'`, `cardId = ticketId`, `ticketId`,
  `boardColumn` backlog/closed, `executionStatus: null`, `displayStatus` "Draft"/"Cancelled",
  `primaryRole: null`, `participatingRoles: []`, `requestedSpecialty`, `priority`,
  `revisionOrdinal`, `attachmentCount`. Ordering, cursor and counts cover both kinds.
  `/cards/:cardId` for a ticket id returns 404 with `details.ticketUrl` pointing to `/tickets/:id`;
  the UI opens ticket cards through `/tickets/:id`.
- Pinned shapes:
  - Create body `{ commandId, title, description, criteria: [string], priority,
    requestedSpecialty: id|null, references: { jiraIssues: [string], jiraParents: [string],
    confluence: [string], figma: [string], links: [string] }, artifactIds: [string] }`; revise
    adds `expectedVersion`; cancel is `{ commandId, expectedVersion }`. Omitted optional fields
    take create defaults (a revision is a full snapshot).
  - Response `revision.references` is the same object with items `{ value, availability }`.
  - `availableActions` is an array of action-name strings; `unavailableActions` is
    `[{ action, reason, milestone }]` as in M1.
  - `GET /tickets/:id/revisions/:revId` -> `{ revision, artifacts: [metadata] }`.
  - `GET /tickets/:id/events?after=&limit=` -> `{ events, nextAfter }` as for cards.
  - `attachmentPolicy` -> `{ maxFiles: 10, maxFileBytes: 10485760, maxTotalBytes: 26214400,
    extractionCharLimit: 100000, formats: [{ extensions: ['.txt', ...], mediaTypes: [...],
    extraction: 'extracted'|'stored_not_read'|'reference_only' }] }` (the three rows of D-M2-4).
- Events: record `ticket_*` after commit (never inside the transaction), `artifact_staged` on upload.
  `GET /tickets/:ticketId/events` lists by `ticket_id`.

## Verification rule

Each wave is checked against the actual diff; `npm test` and
`sha256sum -c docs/m0/reference-integrity.sha256.txt` pass at each wave. Upgrade and restore
steps are documented in `docs/operations/state-upgrade.md` (wave 2 deliverable).
