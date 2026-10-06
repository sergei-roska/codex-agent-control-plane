# Adaptive route backlog

Decision record: `docs/adr/adaptive-delivery-route.md`. Branch:
`feature/dashboard-integration`. Workers do not commit; the lead verifies each
package and commits it. Run only the named test files, never the full suite
without a concrete need.

## Status

| ID | Package | Owner tier | Depends on | Status |
| --- | --- | --- | --- | --- |
| AR-0a | Baseline measurement of the two CDB-390 runs | auditor-sonnet | - | done (numbers in the ADR) |
| AR-0b | Why Intake and lead made 2-5 calls per run | auditor-sonnet | - | dispatched |
| AR-0c | `npm run usage` covers ticket/product run, Intake and lead rows | worker-sonnet | - | dispatched |
| AR-1 | `src/route-gate.js` pure module and tests | worker-sonnet | - | dispatched |
| AR-2 | Preset variants, plan validation, Intake `route` field, project policy | worker-sonnet | AR-1 | planned |
| AR-3a | Derived required-ness and promotion in the lead runtime and candidate gate | worker-sonnet, then auditor-opus review | AR-2 | planned |
| AR-3b | Deterministic `decide` for a clean lean run | worker-sonnet | AR-3a | planned |
| AR-4a | Resubmit of a blocked ticket reuses the ready Intake and plan | worker-sonnet | AR-3 (same files) | planned |
| AR-5 | Shadow-mode recording, telemetry fields, TEAM.md and operator guide | worker-sonnet | AR-3a | planned |
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

- `profiles/delivery/presets/bugfix.json` version 1.1.0 adds `variants` with `full`
  (current stages) and `lean` (stages `implement`, `verify`, and `review` marked
  `conditional: true`). A conditional stage may have `required: false` in the plan;
  every other preset stage must stay required.
- Plan JSON gains `route` ("full" or "lean", default "full"); Intake output gains
  `route` and `routeReason`. `validatePresetPlan` rejects `lean` on any preset
  other than `bugfix` and rejects a lean plan that the route gate would not accept
  (the caller normalizes to `full` and records `routeReasons` instead of failing).
- Project policy (`src/project-config.js`): `adaptiveRoute` in `off|shadow|on`
  (default `off`), optional `routeLimits`.

### Lead runtime (AR-3a, AR-3b)

- `effectiveRequired(plan, route, promotion)` is pure; `planViolationsOf` and
  `candidateGate` use it. The conditional `review` is required iff promoted.
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
| AR-2 | `profiles/delivery/presets/bugfix.json`, `profiles/delivery/pack.json` if needed, `src/plan-validator.js`, `src/intake.js`, `src/project-config.js`, their tests |
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
