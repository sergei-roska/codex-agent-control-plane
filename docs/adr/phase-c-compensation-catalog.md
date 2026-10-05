# ADR: Phase C compensation catalog

Status: WAL-03 catalog decision accepted; defer WAL-04 durable Saga
implementation. Evidence baseline: `c6b7e69`.

## Decision

No supported operation in the reviewed runtime is currently registered with
complete, durable compensation semantics. Do not activate Saga or claim that
workspace snapshot deltas are undo data. Reconcile ambiguous effects first;
compensate only registered effects, in reverse dependency order, after checking
ownership and the expected post-effect version.

| Operation class | Current evidence and catalog disposition |
| --- | --- |
| Workspace file replacement or deletion | Snapshots fingerprint dirty and untracked paths before and after a writer; they do not keep content before-images. The writer lease is workspace-wide and does not fence per-path versions. No supported compensation. A future entry needs a captured before-image (including required metadata), owner identity, and post-version check; preserve foreign edits. |
| Temporary registry replacement | The project registry uses a temporary file, fsync, and rename; rollback in memory can recover an in-process failure. This does not provide a durable before-image or crash-recoverable undo record. No Saga compensation. |
| Grouped local SQLite changes | Use the native database transaction for local atomic work. Session deletion groups its row changes in one transaction and refuses while related executions are active or unresolved; committed deletion has no undo. Treat a transaction as atomic work, not as a compensatable Saga step. |
| Dispatch journal and usage ledger | Journal transitions use conditional state changes and stable attempt IDs; usage inserts are idempotent (`INSERT OR IGNORE`). These are monotonic records, not reversible external effects. |
| Evidence records | Writes are idempotent while the matching row remains unexpired. Evidence defaults to 30 days, configurable from 1 through 365 days. Expiry removes stored payloads; this retention is not a before-image or compensation guarantee. |
| A2A task effects | The writer path records task status and avoids resending a writer when outcome is unresolved; it does not provide undo. Read-only task context lookup has no deduplication guarantee. |
| External APIs and MCP | No registered operation with authoritative status lookup, idempotency, inverse semantics, and bounded expiry was demonstrated. The reviewed MCP allowlists are empty. Treat external effects as unsupported. |

The catalog therefore has no currently compensatable workspace or API
operation. Irreversible actions, unknown partial effects, and effects lacking
authoritative status or ownership/version evidence are unsupported. If an
operation partially fails or its result is ambiguous, reconcile its actual
state before any retry or compensation. A compensation failure must be
recorded explicitly and bounded; never report the forward operation as undone
without verifying the inverse effect.

## Alternatives considered

- Add a general Saga now: rejected because no registered effect has the
  before-image and fencing contract needed to preserve later or foreign edits.
- Use Git/workspace deltas as before-images: rejected because fingerprints do
  not retain file contents and omit relevant filesystem effects.
- Use native database transactions for local atomic groups: accepted where the
  operation and database support the complete change in one transaction.
- Register only operations with explicit inverse semantics and durable
  reconciliation: accepted as the future WAL-04 boundary.

## Reopen WAL-04 when

1. Each selected forward operation records its owner, durable before-image or
   equivalent inverse data, expected post-version, idempotency/status contract,
   and expiry before the effect is applied.
2. Compensation verifies ownership and post-version, preserves foreign edits,
   reconciles ambiguous partial effects, and follows reverse dependency order.
3. Crashes between effect and journal update, repeated compensation, expiry,
   unsupported irreversible actions, and compensation failure have explicit,
   tested outcomes.
4. The selected workflow is under the proven mutation boundary approved by
   DBC-06, and its catalog entries and limits are reviewed. A materially
   different enforced route requires reopening the backlog decision.

Evidence retention of 30 days (1..365 configurable) applies only to evidence
artifacts. Compensation expiry must be set from the selected operation's
recovery needs and cannot inherit that setting by implication.

## Sources

- Snapshot entries hash current dirty/untracked paths, not before-image content;
  ignored files are excluded and directories are not hashed:
  `src/workspace-snapshot.js:8-9`, `:23-31`, `:56-75`. Writer admission stores
  before/after snapshots and deltas under a workspace-wide holder, without a
  path-version fence: `src/writer-admission.js:41-76`, `:129-145`, `:204-213`.
- Registry persistence uses temporary-file fsync and rename; add/remove restore
  the in-memory records on a caught persistence error:
  `src/launcher-projects.js:115-127`, `:270-281`, `:286-299`.
- Session and related-row deletion uses a SQLite transaction and checks for
  active/unresolved writer rows before deleting:
  `src/launcher-sessions.js:119-152`, `:155-166`.
- Journal transitions are conditional and attempt-keyed;
  `src/durable-store.js:285-320`. Usage inserts are idempotent by entry id:
  `src/usage-ledger.js:70-90`.
- Evidence writes deduplicate only while the matching row is unexpired;
  expiry is computed from the configured retention:
  `src/evidence-store.js:216-254`; retention parsing accepts 1..365 and
  otherwise uses the 30-day default: `src/evidence-store.js:18-20`, `:66-74`.
- Task lookup by context supports submission reconciliation, but is not an
  inverse operation: `src/lead-graph.js:900-910`. Reviewed role MCP
  allowlists are empty: `test/role-catalog.test.js:86`.
