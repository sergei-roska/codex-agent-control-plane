# Adaptive route backlog

Decision record: `docs/adr/adaptive-delivery-route.md`. Branch:
`feature/dashboard-integration`. Workers do not commit; the lead verifies each
package and commits it locally (not pushed; push, merge, and tag need the owner).
Run only the named test files, never the full suite.

## Status

| ID | Package | Owner tier | Depends on | Status |
| --- | --- | --- | --- | --- |
| AR-0a | Baseline measurement of the two CDB-390 runs | auditor-sonnet | - | done (numbers in the ADR) |
| AR-0b | Why Intake and lead made 2-5 calls per run | auditor-sonnet | - | done: 2 of the Intake calls were corrective retries (89,245 input, 18% of Intake+lead; cause lost because attempt-1 errors are not persisted, see AR-8); every lead turn was fully determined by the binding plan (only `decide` calls a model), which supports D8; the Intake prompt text is about 1.5k tokens yet each call bills 35-59k input, so the fixed per-call prefix dominates and call count is the lever |
| AR-8 | Persist attempt-1 Intake validation errors (observability only) | worker-sonnet | - | done (`b5f03af`, `retryErrors` in the `intake_completed` event; lost if attempt 2 throws a transport error) |
| AR-10 | Check that the pinned reasoning effort is applied (ledger shows reported "low" vs requested xhigh on Intake and lead turn 1) | auditor-sonnet | - | done: reporting artifact, not a defect. `turn/start` carries the pinned effort on every turn and the Codex rollout `turn_context.effort` shows xhigh for PM/lead and high for workers on every turn of both runs. The ledger `reported` value is the thread default at `thread/start` (the server does not take effort there), so it follows the global Codex config at that moment. Optional later: label the column and record the turn-level effort. |
| AR-2b | Wire `intakeSchemaFor` into the Intake call, fix the preset version expectation in `test/delivery-pack.test.js`, omit `adaptiveRoute` from the normalized config when `off` | worker-sonnet | AR-2, AR-8 | done (in `38654a0`; an outdated test expectation was fixed separately) |
| AR-0c | `npm run usage` covers ticket/product run, Intake and lead rows | worker-sonnet | - | done (`fe290c7`, totals match the baseline) |
| AR-1 | `src/route-gate.js` pure module and tests | worker-sonnet | - | done (`f576ec5`) |
| AR-2 | Preset `lean` block, Intake `route` field and `routeDecision`, project policy, Drupal protected-path additions | worker-sonnet | AR-1 | done (`b47f92d`) |
| AR-3a | Derived required-ness and promotion in the lead runtime and candidate gate | worker-sonnet, then auditor-opus review | AR-2 | done (`38654a0`); known gap: an attested out-of-scope path fails the stage first, so it promotes as `stage_not_succeeded` |
| AR-3b | Deterministic `decide` for a clean lean run, server re-verifies eligibility, `empty_delta` promotion | worker-sonnet | AR-3a | done (`eaee808`); graph-level tests for an open worker decision and an unresolved writer are covered only by `canScript` unit tests |
| AR-4a | Resubmit of a blocked ticket reuses the ready Intake and plan | worker-sonnet | AR-3 (same files) | deferred: saves about 11% only in the rare platform-failure case; do it if such failures recur |
| AR-5a | Journal events `route_decided` and `route_promoted`, telemetry and API `route` field, skipped stage in live views | worker-sonnet | AR-3a | dispatched |
| AR-5b | Route badge and skipped-stage rendering in `web/dashboard` (depends on the AR-5a UI findings) | worker-sonnet | AR-5a | planned |
| AR-5c | Docs: README policy key, operator guide section | lead | - | done |
| AR-9 | Independent Opus review of the lead runtime changes (resume safety, promotion idempotence, scripted-decision fallback) before `on` is used for real tickets | auditor-opus | AR-5a | planned |
| AR-6 | Live acceptance: new direct ticket with the CDB-390 text, `adaptiveRoute: on` | lead | AR-3b, AR-5 | planned |
| AR-D5b | Candidate-level re-attest run | auditor-opus design first | AR-6 | deferred |
| AR-7 | Context trimming for read-only roles | tbd | AR-0b, AR-6 | conditional |

## Contracts (decided by the lead)

### Route gate (`src/route-gate.js`, AR-1)

- `DEFAULT_ROUTE_LIMITS = { maxFiles: 3, maxChangedLines: 30 }`.
- `resolveRouteLimits(policyLimits) -> { maxFiles, maxChangedLines, protectedPaths }`;
  policy can only extend `protectedPaths`.
- `isProtectedPath(relPath, extraPatterns) -> boolean`.
- `evaluatePlanRoute({ classification, plan, policy }) -> { requested, verdict, effective, mode, reasons }`;
  `effective` is `verdict` only when `mode === 'on'`, else `full`.
- `evaluateDelta({ allowedFiles, changed, checksPassed, scopeExpansions, needsDecision, limits }) -> { promote, reasons }`;
  fail closed (unknown delta promotes).
- Reason codes: `not_bugfix`, `not_requested`, `too_many_files`,
  `protected_path:<path>`, `no_mechanical_check`, `policy_off`, `delta_unknown`,
  `check_not_passed`, `outside_allowed_files:<path>`, `too_many_changed_lines`,
  `scope_expansion`, `needs_decision`.

### Plan and preset (AR-2)

- The plan keeps the four-stage shape for every route; nothing in stage structure
  or `required` flags changes. `profiles/delivery/presets/bugfix.json` version 1.1.0
  keeps `stages` as is and adds a `lean` block: `{ skip: ["reproduce"],
  conditional: ["review"], purposeOverrides: { implement: "<text>" } }`. The
  validator checks that the block references existing stage keys.
- Plan gains optional `route` ("full" or "lean") and `routeReason` (string, at most
  200 chars), proposed by the PM. The validated Intake result attaches
  `plan.routeDecision = { requested, verdict, effective, mode, reasons }` computed
  by `evaluatePlanRoute`; a ticket or model proposal can never force `lean`, and an
  ineligible proposal is not an error: the verdict is `full` with reasons.
- Intake prompt and schema mention `route` only when policy `adaptiveRoute` is not
  `off`; with `off`, the prompt and the persisted plan stay byte-identical to today
  (no extra tokens, same plan hash, existing tests unchanged).
- Project policy (`src/project-config.js`): `adaptiveRoute` in `off|shadow|on`
  (default `off`), optional `routeLimits`.

### Lead runtime (AR-3a, AR-3b)

- `effectiveRequired(plan, route, promotion)` is pure; `planViolationsOf` and
  `candidateGate` use it. In an effective lean run `reproduce` is skipped (a
  skipped stage satisfies its dependents and is reported as skipped) and `review`
  is required iff promoted.
- Promotion input comes from the attested writer delta (the source acceptance
  uses), never from worker-reported `filesChanged` alone. Unknown delta promotes.
- Event `route_promoted` with reason codes (`src/event-journal.js` EVENT_TYPES and
  allow-listed payload fields). Promotion is idempotent across graph resume.
- AR-3b: the `decide` node builds the assignment for the next eligible lean stage
  from the plan without an LLM call; after a failure, rejection, promotion, or plan
  violation the LLM lead takes over.

## Write scopes (to avoid concurrent edits)

| Package | May edit |
| --- | --- |
| AR-0c | `src/usage-report.js`, `test/usage-report.test.js`, minimal `src/usage-ledger.js` |
| AR-1 | `src/route-gate.js`, `test/route-gate.test.js` |
| AR-2 | `profiles/delivery/presets/bugfix.json`, `profiles/delivery/pack.json` if needed, `src/plan-validator.js`, `src/intake.js`, `src/project-config.js`, `src/route-gate.js`, their tests |
| AR-8 | `src/delivery-controller.js` (intake retry section only), `src/event-journal.js`, their tests |
| AR-3a/b | `src/lead-orchestrator.js`, `src/lead-graph.js`, `src/delivery-controller.js` (candidateGate only), `src/event-journal.js`, their tests |
| AR-4a | `src/delivery-controller.js`, `src/product-store.js`, their tests |
| AR-5 | `src/ticket-telemetry.js`, `profiles/delivery/TEAM.md`, `docs/m9/operator-guide.md`, tests |

AR-3a, AR-3b, and AR-4a all touch `src/delivery-controller.js` and run in sequence.
AR-0c and AR-1 are disjoint and run in parallel.

## Live acceptance (AR-6)

The CDB-390 internal ticket is `done`; the API refuses resubmit, return-to-backlog,
cancel, and revise on it, and re-import returns the same ticket. The supported
clean re-run is a new direct ticket with the CDB-390 text (title, description,
criteria from revision `rev_AYKvOPnqoGo1wL8Cn8tSgQ`) on clean `master`
(`a99ac3423e857a59581292e6f3d80f2d5a143fc2`) in `/home/sr/Projects/cdb`. Its branch
will be `bugfix/<slug>-<suffix>`, with no Jira link; the old ticket keeps showing
the deleted commit `4d07be648` (object still present, unreferenced). The local
branch `bugfix/CDB-390` was deleted on 2026-10-06 at the owner's request.
Compare the new run with the AR-0a baseline using the AR-0c usage report.
