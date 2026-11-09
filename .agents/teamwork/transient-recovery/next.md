# Next priority after A1 acceptance

Owner requested continued Harness work using docs/harness-autonomy-audit-2026-10-21.md.
A2 follows A1: authorized verification capability and persistent owner decisions.
Do not treat historical missing sandbox capability as still present; HAR-03 native
permissions already landed in a34de1e and must be reused.

Start with current task/run metadata through read-only APIs and source contracts,
not a live run restart. Inspect src/project-settings.js ownerChecks,
src/execution-permissions.js native policy, src/acceptance.js pinned checks,
review target receipts and existing environment decisions. Define an execution
preflight that establishes required capabilities before long work; reusable owner
route authorization must remain separate from fresh candidate-bound evidence.
Owner choices should persist across candidate changes within their scope, while
changed candidates still need fresh passing verifier/auditor receipts.
No automatic external CI trigger, new spending, remote write, target edit, service
restart or model trial is authorized just by a handoff.

A3/A4 remain after A2: internal planning recovery and structured owner-only blocker
dispositions. Preserve honest partial completion, review gates and owner pauses.
