# Terminal Partial audit

Read-only source audit, 2026-10-22. `src/lead-graph.js` creates a Partial ledger on four paths:

- Explicit lead `finish` with `goalAchieved:false` and a checkpoint ledger (around line 3158).
- A second unmet-goal `finish` after one redecide (`goal_unmet_exhausted`, around line 3171).
- Invalid planning after two same-thread corrections and one fresh-context attempt (`planning_contract_failure`, around line 3114).
- Settled repeated work (`no_progress_loop`, around line 3948).

Budget exhaustion and typed human input route to pauses, not terminal Partial. The current accepted-review repair addresses a false `no_progress_loop` when an exact current-target receipt becomes accepted. A separate bounded fix excludes proven pre-turn stale-origin recovery from the review recurrence count. Both remain subject to final review and loaded-runtime qualification.

Next bounded candidate after observing the resumed real lead: `goal_unmet_exhausted` can terminate after one redecide without proof that a local repair or role handoff was tried. Investigate the actual terminal evidence before changing behavior. If it shows a locally repairable check, dependency, or environment failure, require at most one targeted repair or investigation dispatch after the first unmet finish, with explicit stop conditions. Keep genuine owner-only prerequisites, budgets, and exhausted local attempts on their existing truthful paths. Do not raise loop limits generally or mark unfinished work accepted.

Acceptance criteria for that later candidate:

1. A locally repairable unmet goal with no repair attempt since the first unmet finish gets one bounded repair or investigation chance before terminal Partial.
2. Repeated failure after that chance remains finite and produces a truthful Partial ledger.
3. Owner-only decisions and budget pauses remain pauses; explicit valid partial ledgers remain valid.
4. Candidate-bound verifier and auditor receipts, pinned required checks, and review gates remain unchanged.
5. A graph regression demonstrates the actual resumed-run failure shape and the resulting path; no synthetic success receipt or skipped check is counted as completion.
