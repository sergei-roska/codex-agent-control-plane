# Auditor routing contract v1

Status: implementation contract frozen on 2026-10-12, implemented and
independently accepted with the isolated evidence in
`docs/auditor-routing-plan.md`. Runtime activation and live qualification are
separate statuses. Policy ID: `auditor-routing/v1`.

## Assignment metadata

New lead assignments include `review`, null for unrelated read-only work, or:

```json
{
  "kind": "risk_change",
  "checkpointId": "api-permissions",
  "reason": "Permission checks changed before dependent API work",
  "paths": ["src/api", "test/api", "package-lock.json"],
  "evidenceIds": []
}
```

Kinds are `routine`, `risk_change`, `performance`, `component_complete`,
`investigation`, `owner_request`, and `pinned_check`. Each non-null context
requires bounded nonempty reason, checkpoint ID, and safe workspace-relative
paths; evidence IDs are bounded strings. A supplied unknown kind is refused.
Runtime computes target identities; callers cannot supply an approval hash.

New material implementation assignments declare routine or critical review
context. Non-material administrative/document-only assignments may use null;
they do not trigger another model review just because a file was written.
The lead is responsible for this classification, including risky configuration.
Verifier's workspace-write profile requires nonempty explicit safe test/check
allowedFiles even for inspection or running existing checks. Permissions do not
require edits. Empty scope remains valid only for an effective read-only role;
the runtime does not guess or broaden permissions after a rejected assignment.
Verifier and auditor tasks cite the same checkpoint and scope. The auditor
requires a non-routine context; `routine` is never an auditor trigger.
Legacy persisted assignments can be read without the new field. Historical
results without context and target identity never establish current coverage.
New direct auditor requests must be structured and supply this context; other
roles retain their existing request modes. Direct audit results do not approve
an unrelated lead run or imply caller permission for external effects.

## Scope and coverage

Target identity binds the actual content of the declared scope, including
uncommitted and new files, check pins, policy, checkpoint, and requirement/run
context. Include relevant dependency/configuration paths in the scope. A hash
of git HEAD alone is insufficient. Missing files have explicit missing markers;
unreadable content, escaped symlinks, and unavailable identity are unknown.
Unknown identity cannot establish coverage. Bound recursive reads and reject
unsafe paths; do not follow a symlink outside the workspace.

Reviews run after the relevant writers finish and integrate. A review cannot
accept the edits of another writer in its execution wave. Verifier may write
only its assigned test/check files; product repair is a new implementation
assignment. Audit itself is read-only and must see stable scoped content.
Verifier may add its authorized tests and bind its receipt to the final
post-verification target, only when measured integration/settlement evidence
proves the permitted delta. Self-reported filenames cannot waive a mutation.
Auditor before/after scope identity must match exactly.
An auditor or read-only pinned-check integrity reviewer reserves the workspace
against managed writers for the whole review interval. Matching endpoint hashes
alone cannot prove that a writer did not alter and restore content during the
review. The reservation does not grant filesystem write authority or a writable
lane, and is released on every terminal/error/cancellation path. Ordinary
read-only exploration retains its existing concurrency.

Store pending verification/audit obligations and matching receipts in the
existing checkpoint state. Ordinary changed candidates need independent
verifier evidence before final acceptance. Declared critical candidates also
need auditor evidence before dependent implementation or final acceptance.
Repairs of a pending checkpoint may proceed; unrelated read-only investigation
may continue. Conservatively block later implementation while a critical
obligation is pending when independence cannot be established.

A checkpoint's declared context is immutable within the run. All assignments
using that checkpoint ID copy the same kind, reason, paths, and evidence IDs.
A reviewer cannot shrink its scope or turn a critical checkpoint into routine
work. Check every proposed writer; one repair does not authorize another
unrelated writer in its batch. A changed declaration uses a separate checkpoint
and preserves the earlier obligations. Choose adequate module/test prefixes at
planning time so routine repairs do not require changing the review scope.

Reuse a matching accepted receipt instead of another model call. Relevant
content, pins, or requirement changes invalidate it. Completed model work alone
is not an approval: invalid reports, failed checks, unresolved writers, and
unavailable target identity cannot satisfy a gate. Auditor summaries begin
with exactly `VERDICT: pass`, `VERDICT: fail`, or `VERDICT: inconclusive`.
Only pass with valid supporting evidence can satisfy an audit obligation.
Diagnostic investigations do not grant acceptance.

The model selects semantic risk areas. Validation checks declarations,
sequencing, identity, and receipts; it does not prove that every risk was
classified correctly. There is no universal per-round audit or verification.
The existing pinned-check preserve/weaken/PRD-owner-review path stays read-only
and fail-safe; it receives explicit `pinned_check` context.

## Durable staging records

New lead decisions also include `records`, an array of at most 20 structured
lesson entries. Legacy decisions default it to an empty array. Each entry has
exactly `id`, `kind`, `status`, `summary`, `evidenceIds`, `relatedIds`, and
`adrPath`. Kinds are `problem`, `remedy`, `architecture`, `verification`, and
`decision`; statuses are `proposed`, `accepted`, `implemented`, `tested`, `open`,
`resolved`, `rejected`, `failed`, `reopened`, `deferred`, and `unknown`. IDs and
summaries are bounded nonempty strings; references are bounded string arrays.
Semantic IDs and related problem IDs use the logger's shared accepted identity
format; malformed or credential-like IDs are rejected before storage lookup.
Architecture entries require a safe workspace-relative Markdown ADR path;
other entries use null. Reuse semantic IDs across updates, and link remedies
and verification to their problem IDs. Automatic failures and owner decisions
are recorded even when the model supplies no explicit lesson entry.

`StagingLog({ db, readonly })` uses the existing SQLite state connection.
`record({ eventId, type, runId, assignmentId, attemptId, role, problemId,
decisionId, target, status, payload })` synchronously persists an immutable
event. Stable event IDs make replay idempotent; conflicting content is an error.
`list({ runId, problemId, type, limit })` reads correlated history. A read-only
reader does not create or migrate a database. Missing tables mean unavailable
history. The server injects the persistent log into lead and direct-role paths.

Record selection, evidence reuse, review results, failed checks and attempts,
findings, remedies, resolutions, owner decisions, and architecture decisions.
Use stable problem/decision IDs and artifact references. Explicit architecture
decisions refer to their ADR; metadata for human-maintained ADRs is indexed in
`docs/production-transfer.md`. Keep proposed, accepted, implemented, and tested
states distinct. Receipt-log failure cannot authorize acceptance. Persisted
events survive restart; a live dashboard stream is not the transfer history.

Do not copy raw tool output, full prompts, environment values, or credentials
into the event log. Use bounded sanitized summaries and evidence references.
The read-only report joins facts by their correlations; usage and token
coverage remain in the existing usage ledger. No currency savings claim is
derived from subscription usage.

## Compatibility and acceptance

Legacy checkpoints remain resumable. Usage-limit continuation retains the
original review context and obligation. Schema validation errors return useful
lead feedback; they do not add an automatic audit call. Direct audit context,
profile overrides, checkpoint restart, duplicate records, and failed log writes
need focused regression cases alongside the existing pinned-check scenarios.

Implementation is accepted only after focused checks, the full existing suite,
and independent review. Live profile loading and resource comparisons require
a separate bounded trial and must not be claimed from isolated tests.
