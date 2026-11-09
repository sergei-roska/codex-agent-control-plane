# Design package review

Verdict: APPROVE after re-review. The package acceptance DAG blocker below is
resolved by explicit local exit gates and deferred integrated V scenario coverage.
This accepts an offline design, not an implemented concurrent engine.

## Re-review evidence

- [read] `implementation-plan.md:21-48` now defines a local exit gate for each
  package, achievable with predecessor code plus injected successor fakes. V
  references are integrated coverage, checked as participants exist and at CN-15.
- [ran] Parsed `implementation-backlog.json`: all 16 packages have nonempty
  `localExitGate` values and valid dependency references. Its
  `validationScenariosMeaning` explicitly defers integrated coverage.
- [read] `target-design.md:349-355` now aligns the initial Fast rule with the
  reviewed source while retaining a future protocol-qualification boundary.

## Historical blocking finding resolved

1. CN-04 previously required integrated V18-V23 before successor CN-10 could begin, with similar premature scenario gates at CN-08 and elsewhere. The local-gate table now makes those predecessor exits achievable; later integrated coverage remains required and cannot be claimed from fakes.

## Verified strengths and limits

- [read] `target-design.md:127-180` distinguishes a committed dispatch intent from remote acknowledgement; lease expiry triggers reconciliation, not duplicate execution, and unknown writer effects retain capacity/fences.
- [read] `target-design.md:216-280` journals non-atomic Git/SQLite publication, requires immutable candidate manifests, and refuses receipt reuse without validated input closure; unknown scope keeps the broad gate.
- [read] `target-design.md:182-215`, `role-policy.md:93-110` keep serialized planner turns while workers run and accept durable owner steering independently of worker completion.
- [read] `target-design.md:282-331`, `validation.md:89-107` preserve finite recovery, exact final acceptance, control fences and crash-window tests.
- [read] `README.md:30-77`, `implementation-plan.md:8-19`, `implementation-backlog.json` consistently target one project first, core role defaults 4/2/2/2 plus one lead, proposed total 12, and exclude per-role account routing/Claude/global brokerage.
- [read] `implementation-plan.md:301-315`, `validation.md:146-162` retain legacy objectives, additive migration and single workspace publication authority.

## Non-blocking

- `implementation-backlog.json` still marks CN-02/06/07 as `implemented_review_pending` despite the completed independent source review; update only after the lead accepts that milestone.

Evidence is document/code reading plus the separate role-settings re-review; no live engine evidence is claimed. Product source and tracked design files were not edited by the critic.
