# Workflow efficiency implementation

Objective: implement the audit-backed improvements with smaller-model agents.
Baseline: 655bb47eca72f49995dd90b98a55c044358e9a7a.
Preserve docs/skill-routing-audit.md and the Russian audit artifact.

## Acceptance criteria

WF1: Explicit verifier fail/inconclusive cannot become accepted evidence even
when the report completed and its commands passed. Preserve strict auditor
contract and existing scope/settlement guards.
WF2: A later matching auditor receives the fresh current-target verifier report
and receipt through a bounded normal/recovery handoff. Exact run/context/target,
assignment, attempt and execution order remain required.
WF3: Repair retains receipt history and can avoid a duplicate verifier only
when trusted settlement and exact unchanged target/context establish reusable
coverage. Pending, unknown, changed or violating effects remain blocked, and
negative audit evidence must not be revived. Restart state stays conservative.
WF4: Full and delta Lead prompts contain deterministic bounded review next steps,
without invented product-task completion. Loaded source instructions prefer
bounded cohesive packages with explicit observations and preserve session limits,
ownership, dependencies and independent gates.
WF5: Independent static review and a source-traced saved-dispatch case, not an
invented live speedup. Existing review-policy test evidence is historical.
The current developer instruction prohibits adding/running tests without an
explicit user request for implementation testing. Do not run further tests;
identify runtime verification as pending, without claiming full qualification.

## Ownership

review_verdict: src/review-policy.js and test/review-policy.test.js.
workflow_engine: src/lead-graph.js, test/lead-graph.test.js, optional new
review-workflow module/tests. Trace completed by workflow_trace.
work_packages: profiles/TEAM.md, lead instructions in src/role-catalog.js,
docs/workflow-efficiency.md. Lead may finish documentation after handoff.
Lead: coordination, acceptance, Git inspection, final documentation.

## Boundaries

This is offline source delivery. No restart, deployment, live run mutation,
benchmark, target codex_team_work edit, external message or Git mutation.
Do not add semantic code-slice hashes or a trust-sensitive receipt migration.
Do not infer infrastructure-only failures from text. Existing exact scoped
content checks remain the reuse boundary. Larger package guidance is not a
promise of better model quality, and deterministic advice is not automatic
acceptance or an arbitrary product DAG scheduler.
