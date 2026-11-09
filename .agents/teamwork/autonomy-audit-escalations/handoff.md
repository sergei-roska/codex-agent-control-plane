# Static autonomy and escalation audit

Read-only source trace; current dirty diff preserved. No source/runtime changes.

## Findings

1. `goal_not_achieved` can pause for the owner without enforcing the stated owner-only boundary. `src/lead-graph.js:2648` says a later false finish pauses only when every remaining blocker is owner-only, while `src/contracts.js:1035-1043` validates only that the final text cites a post-investigation read-only assignment. `src/lead-graph.js:3027-3028` then unconditionally calls `escalate` for that accepted false finish. Therefore a lead can describe a fixable implementation blocker, cite an investigation, and still create an owner pause. This is an avoidable escalation path (read; semantic classification is not mechanically enforced). Bounded repair: require structured blocker disposition in the validated finish/partial contract, or keep non-owner blockers in the dispatch/partial path. Add a negative test where an investigation finds a fixable cause and ensure it does not pause; preserve owner pause coverage for a genuinely owner-only cause (`test/lead-graph.test.js:5290-5308`, `5345-5357`).

2. Non-quota model/service errors stop the graph instead of entering bounded recovery. In `src/lead-graph.js:2818-2835`, rejected thread resume gets one fresh-thread retry; usage limits become resumable `waiting_for_budget`, but every other error is rethrown. `src/contracts.js:1098-1100` classifies only usage limits specially. Thus transient service/model unavailability can terminate the run and lose automatic progress, while quota handling already demonstrates durable resume. Bounded repair: classify known transient availability errors separately, permit a small capped retry with backoff or persist a resumable infrastructure pause; never silently switch account identity. Existing coverage proves quota pause/resume (`test/lead-graph.test.js:725-743`, worker case 746-767) and rejected-thread retry in app server, but no lead-availability retry/resume case was found (search/read).

3. Repeated invalid lead decisions trigger an owner pause after two correction retries (`MAX_AUTO_REJECTIONS=2`, `src/lead-graph.js:616,2969-2978`). The retry prompt includes validation predicates (`src/lead-graph.js:2562-2566`); only after the third invalid output does the system ask the owner to continue/replan. This is bounded and avoids executing invalid work, but the owner is asked to handle a recoverable formatting/contract failure rather than the agent making a partial result. Consider a local retry limit plus explicit failed/partial terminal status or resumable retry, while retaining owner input for actual owner-only decisions. Existing coverage exercises successful correction (`test/lead-graph.test.js:3037-3057`) and repeated unresolved worker decisions (`877-900`), but did not find a focused third-invalid-decision assertion (search).

## Legitimate boundaries and current diff

- `request_human_input` is constrained to the closed owner-only reason set and a cited, completed read-only investigation (`src/contracts.js:868-891`; prompt policy `src/lead-graph.js:631-632,2645-2648`). These are legitimate owner boundaries: money/paid resources, credentials/access, external writes, irreversible operations, requirement changes, and proven missing dependency/environment capability.
- Explicit configured round caps pause for owner continuation (`src/lead-graph.js:3047-3050`; tests `test/lead-graph.test.js:5379-5410`). The cap is caller-controlled; default unlimited behavior is stated at `2649`.
- The current dirty diff adds deterministic no-progress partial completion rather than owner escalation after repeated settled work (`src/lead-graph.js:3757-3801,4247-4251`; tests `test/lead-graph.test.js:6278-6317`). Preserve this behavior. Loop guard thresholds are warning after 3 and pause after unchanged recurrence (`src/loop-guard.js:8-12,261-287`); the changed graph converts settled pause into partial completion only when no unresolved writer, usage limit, owner pause, cancellation, or active human request exists.

## Relevant evidence

- Contract tests: `test/contracts.test.js:853+` for investigation-before-owner-input; `test/contracts.test.js:93-126` for partial ledger validation.
- Loop tests: `test/loop-guard.test.js`; lead graph recurrence coverage `test/lead-graph.test.js:6041+` and `6278+`.
- Model execution profiles exposed by the lead are fixed role `model`/`effort` (`src/lead-graph.js:2618`). Account profile storage supports explicit active profile selection, not automatic model availability fallback (`src/account-profiles.js:12-47,108-130`). Do not treat account switching as an automatic retry without an explicit identity policy.
- Working tree was already broadly dirty across source/docs/tests, including `src/lead-graph.js`, `src/contracts.js`, and `src/loop-guard.js`; audit claims above are traced to current files and the supplied current-owner handoff. No diff was overwritten.

Status: complete
Scope expansion: none
