# AD-01 lead planner provider-call binding

Role: junior_worker (Luna). Repository: `/home/sr/Projects/Workspace/codex-agent-control-plane`. Baseline source: `ab5c195` plus the existing uncommitted backlog-reset, objective-binding, concurrent-path, and worker-call-binding changes. Shared checkout; no other agent may edit files listed below. Read root `AGENTS.md`, `.agents/teamwork/PROJECT.md`, the provider-binding contract and handoff, the AD-01 backlog section, and `/home/sr/codex-work/agents/junior_worker.toml` before editing.

## Goal

Close the known AD-01 gap: bind every legacy lead-planner `appServer.run()` invocation to the selected configured account identity at the switching-wrapper boundary. The wrapper must durably record the binding before calling the provider. Lead calls have no A2A worker task, so represent their run/attempt/task lineage honestly; do not label a worker task or fabricate turn-start evidence. Preserve the objective binding and existing worker-call records.

## Verified context

- `src/lead-graph.js` runs the lead model in `runLead` near line 2951. `state.runId` is the root A2A task ID: `src/server.js` passes `taskId` as `runId` to `orchestrator.run` and `.resume`.
- A2A workers pass `runId`, `attemptId`, `assignmentId`, and actual worker `taskId` through `callBinding`; `src/app-server-switch.js` strips this internal option and awaits durable persistence before `target.run()`.
- `DispatchJournal.recordCallBound` currently requires a dispatch attempt linked to run, assignment, and task. It pins the first worker task ID on that parent attempt. Lead planning needs an explicit, validated extension or a truthful lead-attempt parent record.
- The role service, worker-binding code, objective binding, and all pre-existing uncommitted user changes are in the shared checkout. Do not revert or broadly reformat them.

## Allowed files

- `src/lead-graph.js`
- `src/durable-store.js`
- `src/app-server-switch.js` and `src/server.js` only if the existing wrapper wiring requires a narrowly scoped change
- `test/lead-graph.test.js`
- `test/durable-store.test.js`
- `test/app-server-switch.test.js` and `test/e2e.test.js` only for focused coverage
- this task's `handoff.md`

Do not edit backlog or other tracked docs. No Git state changes, no live provider calls, and no real quota use.

## Acceptance

- Every lead provider invocation gets its own unique invocation ID and a durable `call_bound` record with the hashed selected configured account identity, run ID, and truthful lead-planning attempt/task linkage.
- A rejected thread continuation followed by a fresh lead call gets a distinct invocation ID. An interrupted call followed by restart leaves the earlier call record intact and does not rewrite its identity from the currently active profile.
- Identity absence or binding persistence failure prevents the provider invocation. No provider turn, completion, or effect is inferred from `call_bound`.
- Existing A2A worker bindings and worker task pinning continue to behave as before. Add focused tests for successful lead binding, a fresh call after continuation rejection, failure-before-provider, and durable restart/reopen if the journal path changes.
- Run syntax checks and focused suites for changed modules. Report exact commands and counts; do not run the entire repository suite without evidence that focused checks justify it.

Update `handoff.md` with the implementation, verification, and any remaining same-home credential boundary. Keep the report under 200 words and end with `Status: complete | partial | blocked` and `Scope expansion: none` or the exact needed path.
