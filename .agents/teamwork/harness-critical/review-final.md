# Independent final expanded review

Verdict: APPROVE
Status: complete
Scope expansion: none

## Evidence

- [read, ran] Core recovery, parallel wave guidance, Git role instructions, launcher diagnostic behavior, redaction repair, and per-target recurrence were reviewed in `review-initial.md` and `review-core.md`. The original JSON credential reproduction now redacts the value on disk and after manager reinitialization.
- [read] `src/execution-permissions.js` resolves native policy only for a canonical trusted project, selecting the nearest configured root. Missing or denied profiles fall back to strict. `src/project-settings.js` defaults missing/valid legacy settings to inherit and invalid/unreadable settings to strict. [ran] Resolver tests 6/6 passed. Worker settings tests 13/13 passed.
- [read] `src/codex-app-server.js` applies selected native permissions and approvals on new/resumed threads, updates changed loaded threads, and skips a settings update for an unchanged fingerprint. Legacy strict sandbox behavior remains available. `permissionWorkspace` preserves the original project trust root for lane cwd. Read-only roles select the read-only profile. [read] Root's disposable native transition and local Git evidence reports success without model turns; worker client tests report 110 passes and two exact baseline failures.
- [read] `src/writer-lanes.js` labels inherited full-access lanes cooperative with `confinement: none`; legacy strict mode retains its confinement probe. `src/server.js` passes the resolved setting to Lead, A2A, and acceptance. Root's disposable startup evidence reports HTTP 200 and cooperative mode.
- [read] Agent checks in `src/acceptance.js` remain App Server commands with pinned-check and before/after snapshot controls; strict mode keeps scratch-only/no-network behavior. Root's disposable native acceptance evidence reports a loopback check accepted. No host fallback was added for agent checks.
- [read, ran] `executionTarget` is a required nullable decision-schema field, with legacy absence normalized to null. Shared is restricted to an engineering administrative request with null review/repair and cannot share an execution group with another writer. A2A routes it through the admitted shared workspace. Focused contract tests 3/3 and A2A test 1/1 passed.
- [read, ran] `src/lead-graph.js` forces a terminal partial only for a settled batch with no unresolved writer, budget, cancellation, human request, or owner pause. Its ledger consults current review gates and always includes a blocked unfinished-goal entry. `accept` runs final checks once; failed checks remain rejected and `finalizeLedger` prevents accepted checkpoint claims on rejected/unverifiable acceptance. Two focused no-progress graph tests passed.

The focused evidence supports the reviewed scope. The lead owns the final broader suite and integration decision.
