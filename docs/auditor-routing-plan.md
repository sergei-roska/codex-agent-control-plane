# Plan: verifier acceptance and selective auditor dispatch

Status: implemented and independently accepted on 2026-10-12 after the owner
stopped both services. Final isolated qualification: 1026 passed, 0 failed,
one optional live confinement probe skipped; independent integrated review
APPROVE. No real model trial or owner service restart was performed.
Read-only inspection found no active/unresolved writers in accessible state files.
Frozen implementation contract: `docs/auditor-routing-contract.md`.
Related problem: P-14 in `docs/production-transfer.md`.

## Outcome

Routine implementation is checked by `verifier` (Quality Engineer), with the
lead deciding whether the evidence satisfies the assignment. `auditor` (Code
Auditor) reviews explicit risk changes and completed components. Round count
alone is never a reason to dispatch either role. Deterministic acceptance,
writer admission, reconciliation, and owner approval remain authoritative.

All staging problems, attempted fixes, verification results, and architectural
decisions are recorded for transfer to the production orchestrator. Proposed,
implemented, and live-verified behavior must have distinct statuses.

## Current call paths and evidence

- `profiles/TEAM.md`, Dispatch: already limits the auditor to phase/milestone
  completion, risk-area changes before dependent work, and unresolved explorer
  investigations. This is model guidance; it is not a dispatch validator.
- `src/lead-graph.js`, decision prompt and rejection feedback: repeatedly names
  "explorer or auditor" for blocker investigation. The lead chooses ordinary
  assignments; there is no unconditional auditor node after every round.
- `src/lead-graph.js`, `reviewRole()` and `startReview()`: a changed pinned
  acceptance script triggers an automatic integrity review. The first available
  read-only role is selected from auditor, architect, explorer, scout. This
  review does not consume another lead round. Verifier is workspace-write and
  is intentionally absent from this read-only path.
- `src/a2a-role-service.js`: generic `/agents/<role>` routes also expose the
  auditor directly. A lead-only dispatch rule would not cover direct requests.
- `profiles/agents/auditor.toml`: read-only, gpt-6.1-sol/high by default.
  `profiles/agents/verifier.toml`: gpt-6-luna/high, owns scoped test/check files.
  Project overrides can change the effective model and effort.
- `docs/adr/auditor-dispatch-points.md` records auditor assignments in rounds
  2-11 of run `a125b4c6`, and round 13 without one. These are historical records,
  not a fresh inspection of the current running process or dispatch journal.
- `src/role-catalog.js` embeds team rules at startup. The current process's
  loaded rules and overrides have not been verified. Lead profile hash changes
  cause session-thread rollover; changes are not hot-reloaded.

## Routing policy

| Situation | Route and gate |
| --- | --- |
| Material routine implementation has been integrated | A later verifier wave checks the actual candidate and focused acceptance cases; lead reviews the diff and evidence. Batch related changes into one verification task. |
| Investigation, unchanged artifacts, or administrative round | No standing verifier or auditor task. Reuse valid evidence. |
| Permission, credential, trust-boundary, authoritative-state, concurrency, recovery, migration, or public-contract change | Verify first; audit the passing candidate before dependent work or final acceptance. Inspect behavior, not just filenames. |
| Performance-sensitive change or a performance acceptance requirement | Verifier collects reproducible measurements; auditor examines the relevant flow and methodology. A performance claim requires measured evidence. |
| Independently usable component or material phase/milestone completed | Audit the integrated candidate once against its requirements, interfaces, and relevant risks. Reuse a matching earlier audit rather than auditing again merely because the run finishes. |
| Ordinary blocker | Explorer investigates first. Auditor is used for a concrete unresolved question or a known risk boundary. |
| Pinned acceptance script changed | Preserve the existing independent read-only integrity review. This is a justified critical audit, separate from routine test execution. |
| Explicit owner audit request | Audit the requested scope and record the owner request as its trigger. |

Failed routine candidates go back for repair before a broad checkpoint audit.
A security or integrity incident may need an immediate bounded investigation
while ordinary checks are failing. That investigation is not an acceptance.
Risk-heavy projects may legitimately need audits in consecutive rounds.

## Work after shutdown

1. **Establish a stable baseline and record the problem.** Confirm shutdown and
   settled writers through existing lifecycle evidence. Preserve the current
   uncommitted work. Inspect the relevant dispatch journal and usage ledger
   read-only, using run/assignment/attempt identities and effective profiles.
   Separate lead-selected audits, automatic check reviews, direct requests,
   retries, and usage-limit continuations. Record counts, duration, token
   coverage, findings, and the baseline revision; unknown values stay unknown.

2. **Align role contracts and prompts.** Update `profiles/TEAM.md`, the verifier
   and auditor profiles, and lead investigation/rejection prompts together.
   Verifier reads actual changes and independently verifies requirements, not
   just the worker's report. Lead retains final judgment. Put verification and
   audit after integration, never in the same wave as the changes they accept.
   Give each audit a bounded scope and a concrete question. Update the existing
   auditor ADR with a dated superseding decision only when the refinement is
   adopted; keep its historical evidence.

3. **Make audit selection inspectable and constrain mechanical mistakes.**
   Freeze an implementation contract before coding: the metadata schema,
   coverage fingerprint, direct-request behavior, and legacy compatibility.
   Define bounded audit context for auditor assignments: trigger, reason,
   component/checkpoint, target artifact identity, and relevant evidence or
   prior finding IDs. Use a closed trigger set corresponding to the table.
   Validate required context and sequencing in `src/contracts.js` and
   `src/lead-graph.js`; annotate the internal `startReview()` path too. Account
   for generic direct-role requests without silently widening their authority.
   Bind review evidence to the actual integrated content and relevant check
   pins, not only git HEAD: this workspace can have uncommitted changes.
   Record declared risk changes and selected completion checkpoints as pending
   audit obligations in the existing run/checkpoint state. Check matching audit
   coverage before their dependent dispatches or finish; persist the obligation
   before admitting dependent work. Relevant code, dependency, configuration,
   or requirement changes invalidate reused coverage.
   Exact continuation of a usage-limited audit keeps its original reason.
   Legacy checkpoints remain readable; absent metadata never proves coverage.
   Validation checks supplied context; it cannot prove a model's risk
   classification. Avoid a universal shell or semantic risk classifier.

4. **Persist problems and decisions for production transfer.** Reuse the
   dispatch journal, checkpoints, usage ledger, and evidence artifacts where
   they supply the needed facts. Add durable append-only event records for
   gaps; a dashboard activity stream alone is insufficient. At each meaningful
   review decision record the role choice or evidence reuse, reason, policy
   version, target identity, timestamps, and run/assignment/attempt IDs.
   Record findings, attempted remedies including failed attempts, verification,
   reopen/close decisions, and their evidence. Use stable problem IDs across
   repeated runs and correlate continuations rather than counting them as new
   decisions. Retry event writes idempotently. A missing durable required
   receipt cannot authorize acceptance. Keep secrets and raw sensitive payloads
   out of logs; link access-controlled evidence instead.

5. **Verify, trial, and publish the transfer record.** Use the scenarios below,
   then a bounded live trial after the updated server starts. Confirm the
   effective role profiles and expected lead-thread rollover. Compare ordinary
   and risk-heavy tasks separately, using matched task classes from the
   benchmark plan. Include lead replanning, verification, automatic reviews,
   retries, and failed attempts in resource totals. Update the ADR status,
   P-14, and `docs/production-transfer.md` with results and remaining limits.
   Inventory existing ADRs and known problem records so prior staging lessons
   have transfer links as well. Mark unknown history as unknown.

Implementation scopes: role contracts/prompts first; schema/graph/compatible
checkpoint changes second; durable records and reporting third. Serialize
overlapping edits. Independent verifier checks behavior; a bounded auditor
reviews dispatch, integrity, and persistence changes before activation.

## Required verification scenarios

- Ordinary integrated changes are independently verified without an auditor
  merely because another round ended; pure investigation adds no standing gate.
- A declared risk change cannot feed dependent work or final acceptance until
  its required audit is satisfied; repair invalidates only affected evidence.
- Review of a completed component sees the integrated candidate. A previously
  reviewed matching candidate is reused; changed relevant content is rechecked.
- Missing audit context and accepting concurrent unfinished edits are rejected;
  risk incidents still permit an explicitly scoped diagnostic investigation.
- Changed pinned checks still require read-only review. Preserve/weaken,
  unparseable verdict, explicit PRD change, and owner approval retain their
  current fail-safe behavior. Workspace-write verifier cannot re-pin itself.
- Direct audit calls, legacy checkpoints, profile overrides, restart/resume,
  duplicate results, and usage-limit continuations retain compatible behavior
  and traceable identities. Persisted required gates survive restart.
- A known failed verification cannot be overridden by a positive model report.
  Missing audit or verification evidence cannot become a pass.
- Problems and failed fixes survive restart; repeated event delivery creates
  one logical record; log failure leaves required decisions unaccepted.

## Definition of done

Every auditor call has a specific recorded trigger and target. Routine changed
candidates have verifier evidence; required critical audits and pinned-check
integrity gates are preserved. There is no universal per-round model review.
Resource reports show measured usage and coverage without an invented currency
cost or promised percentage saving. Each discovered problem and architectural
decision has a linked transfer record with status, evidence, and a production
recommendation. Activation happens only after shutdown, required checks, and
independent review; the current running orchestrator is not modified.

## Implementation evidence

- Baseline revision: `55164c4f3ea4fc54f211998b842ee9d29c5b724e`, plus existing
  uncommitted changes, preserved throughout implementation.
- Read-only inspection of accessible `.runtime` state files found no held
  writers and no matching historical `a125b4c6` usage/journal records. Historical
  exact duration, assignment IDs, and token coverage remain unknown.
- The first sandboxed suite could not complete because existing tests require
  `/var/tmp` writes and local test services. A permitted run outside the sandbox
  finished with 980 tests: 978 pass, one existing live-test skip, one schema
  fixture mismatch during concurrent implementation. This is not a stable
  baseline or final acceptance run; focused and final checks follow.
- Static log review found history tie ordering, incomplete-history status,
  missing-table ambiguity, and sanitizer gaps. Problems and remedies are indexed
  in `docs/production-transfer.md`; passing tests alone did not waive review.

## Final qualification

Implemented role contracts, bounded review/record schemas, checkpointed gates,
scoped receipts and reuse, protected audit reservations, original-target
continuation, durable staging events, and the read-only reporting command.
Preserved pinned-check owner/integrity semantics and legacy checkpoint reading.
Code and root instruction changes are ready for the owner's next service start.

- Core focused suites: 310 passed before final review fixes. Final affected
  record/identity suites: 234 passed; snapshot/integration suites: 235 passed.
- Final full command: `env -u NODE_TEST_CONTEXT npm test`, outside the sandbox
  for existing scratch and local HTTP checks. 1027 total, 1026 passed, 0 failed,
  0 cancelled, one optional live confinement probe skipped, 33737.267734 ms.
- Full log: `/tmp/codex-auditor-implementation.WuqU6C/full-suite-attempt-3.log`.
  Failed and intermediate attempts remain in the same directory and are
  summarized under P-16..P-28 in the production transfer index.
- Independent review: APPROVE after sanitizer, audit interval, record feedback,
  identity validation, and Git snapshot findings were fixed. `git diff --check`
  passed. Existing unrelated uncommitted changes were retained.

Live profile loading, model-selected audit frequency, and matched resource
savings still require a bounded staging trial after restart. No savings amount
or live behavior is inferred from these isolated results.

## Plan review record

2026-10-12: independent static plan review APPROVE. Reviewed source call paths,
role contracts, integrity gates, shutdown sequencing, and transfer records.
The exact audit schema, coverage fingerprint, and direct-request behavior still
require the implementation contract in step 3. Historical dispatch observations
were not independently rechecked. No runtime tests or live trial were run.
