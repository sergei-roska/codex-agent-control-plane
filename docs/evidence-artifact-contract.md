# Evidence reference contract (PIP-01)

Status: frozen for Phase A, contract `evidence-ref/v1`. Consumers implement
against this document; a change reopens PIP-01 and marks PIP-02..PIP-04 stale.

## Problem

Bulky output reaches the lead inline or is cut silently (facts verified at
revision `c722d95`):

- `assignmentResult` cuts artifact text at 100000 chars (`src/lead-graph.js:132`,
  `:148`). A larger valid report is cut mid-JSON, fails `parseWorkerReport`, and
  becomes `reportError` plus 12000 chars of text with no marker
  (`src/lead-graph.js:334`, `:350`); for a writer, acceptance then rejects on
  `report_invalid`.
- worker-report/v1 arrays (`filesChanged`, `filesInspected`, `risks`, `checks`,
  `scopeExpansion`, `checks[].detail`) have no item or length caps
  (`src/contracts.js:204-227`), and every valid report is re-sent whole in every
  later lead prompt through `JSON.stringify(state.outcomes)`
  (`src/lead-graph.js:380`).
- Acceptance checks keep an 8192-char rolling buffer per stream and report a
  4096-char tail with no truncation flag (`src/acceptance.js:13`, `:90-91`,
  `:115-116`); the lead sees only the exit code (`src/acceptance.js:144`).
- Every cut in `src/lead-graph.js` (`:122`, `:128`, `:132`, `:135`, `:148`,
  `:163`, `:350`) is a silent `.slice`.

## Decisions

1. Evidence is stored in the existing state database (`openStateDatabase`,
   `src/durable-store.js:118`; file mode 0600, directory 0700 are already
   enforced there). No evidence file tree exists, so an evidence ID never maps
   to a filesystem path and traversal or symlink escape is impossible by
   construction. `.runtime/artifacts/` is not used.
2. Every evidence item is owned by one lead run (`runId` = lead task id). Phase A
   has exactly two producers, both run-owned:
   - P1, the lead graph, on receipt of a specialist task result (PIP-03).
   - P2, acceptance checks, for stdout and stderr of each required check (PIP-03).
   Direct `/agents/<role>` requests produce no evidence in Phase A; their full
   artifact already lives in the task store and is returned to the caller.
   Command output inside Codex turns is not captured in Phase A (the App Server
   item schema must be verified first; deferred to PIP-05).
3. Retrieval is an internal API plus an operator CLI. Phase A exposes no HTTP
   route. A later HTTP route must use its own prefix (`/evidence/<id>`), apply
   `createAuthMiddleware` explicitly, require the owning `runId`, and never be
   proxied by the launcher until the launcher has its own authentication
   (`src/launcher-app.js` serves `/api/projects/...` without auth today).
4. Projection, truncation, and summaries are deterministic code. No model call
   produces or reads evidence.
5. A missing, expired, corrupt, or unstored item is unknown evidence. It never
   counts as passing and never satisfies a predicate.

## Evidence reference (`evidence-ref/v1`)

The reference is what outcomes, graph state, artifact metadata, and the lead
prompt carry. Field names are part of the contract.

| Field | Type | Meaning |
| --- | --- | --- |
| `contract` | `"evidence-ref/v1"` | Version. Consumers treat any other value as unknown evidence. |
| `id` | string | `ev_` followed by 32 lowercase hex chars (128 random bits). Never derived from content or paths. |
| `runId` | string | Owning lead run. |
| `attemptId` | string or null | Journal attempt id for P1 (`<runId>:r<round>:a<idx>:t1`). |
| `taskId` | string or null | Specialist task id for P1. |
| `checkId` | string or null | Acceptance check id for P2. |
| `kind` | enum | `worker_result_text`, `check_stdout`, `check_stderr`. |
| `mediaType` | string | `text/plain; charset=utf-8` or `application/json`. |
| `stored` | boolean | False when the payload was not stored (quota). |
| `originalBytes` | integer | Bytes the producer saw, before any cap. |
| `storedBytes` | integer | Bytes of the stored payload (0 when `stored` is false). |
| `truncated` | boolean | True when `storedBytes` covers less than the original. |
| `omitted` | null or `{ offset, bytes }` | The original byte range missing from the payload. |
| `sha256` | string or null | Hex SHA-256 of the stored payload; null when not stored. |
| `originalSha256` | string | Hex SHA-256 of the full original bytes, computed while streaming. |
| `summary` | string | At most 2000 chars, produced by the producer; states any omission in words. |
| `source` | object | Producer metadata; see below. |
| `createdAt`, `expiresAt` | integer | Epoch milliseconds. |
| `error` | null or code | Set on a ref that describes a failed write (`evidence_quota_exceeded`). |

`source` for P1: `{ "producer": "lead_graph", "role": <canonical role id> }`.
For P2: `{ "producer": "acceptance", "argv": [...], "exitCode": int|null,
"signal": string|null, "timedOut": bool, "canceled": bool, "stream": "stdout"|"stderr" }`.
Stream separation and exit status are therefore preserved per check.

## Storage and bounds

Table `evidence` in the state database, created idempotently by
`src/evidence-store.js` (`CREATE TABLE IF NOT EXISTS`, like `usage_ledger`):

| Column | Notes |
| --- | --- |
| `id` TEXT PRIMARY KEY | validated format before any query |
| `run_id` TEXT NOT NULL, `attempt_id`, `task_id`, `check_id` TEXT | ownership; index on `run_id` |
| `kind`, `media_type` TEXT NOT NULL | |
| `state` TEXT NOT NULL | `stored`, `expired`, `not_stored`; CHECK constraint |
| `payload` BLOB | null unless `state = 'stored'` |
| `stored_bytes`, `original_bytes` INTEGER NOT NULL | |
| `omitted_offset`, `omitted_bytes` INTEGER | null when not truncated |
| `sha256` TEXT, `original_sha256` TEXT NOT NULL | |
| `summary` TEXT NOT NULL, `source_json` TEXT NOT NULL | |
| `created_at`, `expires_at` INTEGER NOT NULL | index on `expires_at` |

Bounds (constants exported by the store):

| Bound | Value |
| --- | --- |
| Stored payload per item | 8 MiB (`MAX_STORED_BYTES`). Longer content keeps the first 2 MiB and the last 6 MiB; the payload contains a marker line `\n[evidence: <n> bytes omitted]\n` between them, and `omitted` records the original range. |
| Stored payload per run | 64 MiB (`MAX_RUN_BYTES`). A write over the quota stores no payload: the row has `state = 'not_stored'`, and the returned ref has `stored: false` and `error: "evidence_quota_exceeded"`, with `originalBytes`, `originalSha256`, and `summary` still set. |
| One read | 1 MiB (`MAX_READ_BYTES`). Larger ranges are refused, not clipped. |
| Summary | 2000 chars. |
| Retention | 30 days from `createdAt`; `CODEX_A2A_EVIDENCE_RETENTION_DAYS` may set 1..365. |

Expiry keeps a tombstone: the sweep sets `state = 'expired'` and nulls
`payload`, so an expired ID answers `evidence_expired`, not `evidence_not_found`.
The sweep runs when the store opens and at most once per hour on write. Deleting a
run through the launcher (`src/launcher-sessions.js:120-132`) also deletes its
evidence rows.

Bytes are stored as produced. Cuts are byte-exact; a summary decodes with
replacement characters for split UTF-8 sequences.

## Interfaces

Producer (`src/evidence-store.js`, synchronous, better-sqlite3):

```text
createEvidenceStore(db, { now?, retentionDays?, randomId? }) -> store
store.put({ runId, attemptId?, taskId?, checkId?, kind, mediaType, content, summary, source }) -> ref
```

`content` is a Buffer or string, or a precomputed capture
`{ head: Buffer, tail: Buffer, originalBytes, originalSha256 }` from a streaming
producer such as `runCheck`. `put` validates every field, writes in one
transaction, and returns the ref. `put` is idempotent: when a row in state
`stored` or `not_stored` already has the same `runId`, `attemptId`, `taskId`,
`checkId`, `kind`, and `originalSha256`, it returns that row's ref and writes
nothing, so a graph replay never duplicates evidence or consumes quota twice.
A row whose `expires_at` has passed is never reused. P2 evidence carries the
acceptance attempt as `attemptId` (`<runId>:acceptance:<n>`, n counting
acceptance runs from 1), so identical output of a later acceptance run gets its
own row with its own exit status.

Consumer:

```text
store.getRef(id, { runId }) -> ref
store.read(id, { runId, offset = 0, length = MAX_READ_BYTES }) -> { ref, bytes, offset, eof }
store.listByRun(runId) -> ref[]
store.deleteRun(runId) -> count
store.sweepExpired(now?) -> count
```

`read` verifies `sha256` over the whole stored payload before returning any range.

Errors are thrown as `EvidenceError` with a stable `code`:

| Code | When |
| --- | --- |
| `evidence_invalid_id` | ID fails the format check (including anything path-like). |
| `evidence_not_found` | No row. |
| `evidence_forbidden` | Row exists but `runId` differs. The message does not reveal the owner. |
| `evidence_expired` | Tombstone. |
| `evidence_not_stored` | Row exists with `state = 'not_stored'`. |
| `evidence_corrupt` | Stored payload checksum mismatch. |
| `evidence_read_too_large` | `length` above `MAX_READ_BYTES`, or negative/invalid range. |
| `evidence_invalid_input` | `put` input invalid (kind, media type, summary length, ids). |

Operator CLI (no planning turn needed): `npm run evidence -- --run <runId>` lists
refs; `npm run evidence -- --run <runId> --id <evidenceId> [--offset n] [--length n]`
writes the bytes to stdout. It opens the state database read-only
(`--state <file>` or `CODEX_A2A_STATE_DB`), as `src/usage-report.js` does, and
exits 1 with the error code on failure.

## Lead projection (consumer rules for PIP-03)

1. Parse the full specialist artifact text before any cut. When the text is
   longer than 100000 chars, P1 stores it as `worker_result_text` evidence.
2. A valid report is projected with these caps, and every capped field adds an
   entry `{ field, kept, total }` to `outcome.projection.omitted`:
   `filesChanged` 100 paths; `filesInspected` 20; `risks` 20 items of 500 chars;
   `checks` 20 items, `detail` 500 chars; `scopeExpansion` 20 items, `reason`
   500 chars. `summary` and `decisionRequest` keep their existing validator
   bounds. If anything was omitted, the full report JSON is stored as
   evidence and its ref is attached.
3. `scopeViolations` and `attestedScopeViolations` are computed from the full,
   unprojected lists. They are never dropped: the outcome keeps the first 50
   paths of each plus `scopeViolationCount` and `attestedScopeViolationCount`.
4. An invalid or unparsable report keeps `reportError`; its text projection is the
   first 6000 and last 2000 chars around the marker line, plus the evidence ref.
5. These outcome fields are diagnostics and are never omitted from any
   projection or digest: `status`, `failureKind`, `reportError`,
   `scopeViolations` (bounded as above), `attestedScopeViolations` (bounded),
   `attestedDeltaKnown`, `writerExecution.state`, `writerExecution.delta.known`,
   changed path count and first 50 paths, `effects`, `failure`.
6. The lead prompt carries at most 60000 chars of outcome JSON. Newest outcomes
   are kept as full projections; older ones that do not fit become digests:
   `{ assignmentId, attemptId, role, status, outcome, summary (300 chars),
   diagnostics (rule 5), evidence ids }`. A digest says `"digest": true`.
   When even digests do not fit, the oldest outcomes become elision entries
   `{ elided: true, assignmentId, attemptId, role, status, violationCodes }`,
   where `violationCodes` lists the non-advisory boundary codes of that outcome.
   Only if those do not fit either does a single `{ digest: true, elided: <n> }`
   count remain. The full outcomes stay in graph state; acceptance always reads
   the full state, never the prompt projection.
7. Acceptance checks attach `check_stdout` and `check_stderr` refs to each
   `acceptance.checks[]` entry. `stdoutTail` and `stderrTail` stay as today and
   gain `stdoutTruncated` / `stderrTruncated` booleans. A failed check's issue
   detail names its evidence ids.
8. The outcome gains optional `evidence: ref[]` and `projection`. Their absence
   on old outcomes and checkpoints means no evidence and no omissions; old
   outcomes are rendered unchanged.

## Compatibility

- worker-report/v1, the model output schema, does not change.
- Resumed runs keep their refs. An expired or missing ref surfaces its error
  code in the outcome diagnostics; it is never treated as a pass.
- The lead artifact metadata (`src/server.js:376`) carries projected outcomes and
  is therefore bounded by rule 2 and rule 5.
- Legacy direct and plain-text specialist calls are unaffected.

## Examples

Successful check with small output (no truncation):

```json
{"contract":"evidence-ref/v1","id":"ev_4f0c2a9e1b7d4c3a8e6f5d2c1b0a9e8d","runId":"6df01bf7-6500-4c0d-8d07-cf435a5a78cf","attemptId":null,"taskId":null,"checkId":"check-1","kind":"check_stdout","mediaType":"text/plain; charset=utf-8","stored":true,"originalBytes":5120,"storedBytes":5120,"truncated":false,"omitted":null,"sha256":"<64 hex>","originalSha256":"<same 64 hex>","summary":"npm test: 401 tests, 401 pass","source":{"producer":"acceptance","argv":["npm","test"],"exitCode":0,"signal":null,"timedOut":false,"canceled":false,"stream":"stdout"},"createdAt":1791216000000,"expiresAt":1793808000000,"error":null}
```

Failed check: same shape with `"exitCode":1` and `kind` `check_stderr`; the
acceptance issue reads `check_failed: check-1 exited 1 (evidence ev_...)`.

Truncated output (a 20 MiB log): `"originalBytes":20971520`,
`"storedBytes":8388644` (8 MiB of content plus the 36-byte marker line), `"truncated":true`,
`"omitted":{"offset":2097152,"bytes":12582912}`, `sha256` over the stored
payload and `originalSha256` over the full 20 MiB.

Retrieval failure: `store.read("ev_...", { runId: "other-run" })` throws
`EvidenceError` with `code: "evidence_forbidden"`; `npm run evidence -- --run
<runId> --id ../../etc/passwd` exits 1 with `evidence_invalid_id`; after
expiry the same ID gives `evidence_expired`.
