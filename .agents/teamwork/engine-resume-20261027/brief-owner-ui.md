# CN14 owner workflow selection and available-lead steering

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read
/home/sr/codex-home/agents/worker.toml developer_instructions and development-access.md.
English/ASCII. Node CommonJS/node:test, Express launcher, plain JS/CSS. Root owns
Git/docs. Preserve inherited dirty source; no live/shared state writes or restart.

Own narrow src/launcher-app.js routes; launcher-ui/backlog.js/html/css and new
steering tests; launcher-ui/roles.js/html/css and dedicated selector tests; optional
NEW helper for atomic project-setting writes. Do not edit performance, server.js,
router, core engine, project-settings.js, role model/Fast/capacity behavior or source
owned by another worker. Core worker owns new engine source/test; backend wiring
will be a separate worker. Root resolves shared contract issues.

Read ../cn14-host-map-20261027/brief.md and accepted launcher/read-projection APIs.
Backend steering contract is fixed for this task:
- Project server GET /control/delivery/:runId returns core controlStatus (or typed
  unavailable): engine/runId/projectId/sessionId/objectiveId plus revisions
  {planRevision,goalRevision,controlRevision,ownerGeneration}, inbox/messages/pending,
  disposition. Auth is existing loopback bearer token.
- POST /control/delivery/:runId/steer takes exactly {runId,projectId,sessionId,
  objectiveId,messageId,text,expectedPlanRevision,expectedGoalRevision,
  expectedControlRevision}. Return core durable received ack immediately; received
  is distinct from applied. Core rejects mismatched scope/revisions/terminal state.
- These server endpoints are not wired yet; backend worker will implement them.
  Use owned fake server fixtures; unavailable old backend must degrade clearly.

Add narrow launcher GET /api/projects/:id/delivery/control?objectiveId&sessionId
that derives runId from scoped existing concurrent_delivery_runs AND engine mapping
(DB readonly, no constructors/tables). Forward to authenticated project server with
existing bounded controlCall pattern, checking returned scope. Add POST
/api/projects/:id/delivery/steer with strict field/body/project scope validation,
actual mapping lookup and same server forwarding; stale revision returns409.
Never let caller-supplied IDs select a different project/session/objective/run.
No ambiguous latest-run fallback. Require running project for writes.

Backlog page must show a useful short message-to-lead form for the selected active
concurrent objective, current applied/received state and optional latest reply.
Snapshot revisions and stable message ID for retry; no automatic stale overwrite.
Project/session/objective changes cancel/invalidate in-flight reads AND sends.
Do not send automatically or write real tasks while testing. Existing page polling,
scoped pagination, role counts, unknown metrics and readable task IDs stay intact.
Bound plain text and render with textContent. Legacy/stopped/unavailable views
explain disabled steering without exposing internal infrastructure details.

Add owner engine selection on Roles page near project/team settings. Existing
project-settings.js already validates legacy|concurrent-v1 and defaults legacy.
Provide additive GET/PUT project delivery-engine endpoint(s); preserve all other
valid owner settings/fields and use atomic0600 temporary-file rename. Invalid
existing settings must not be overwritten with defaults. Change allowed only
while project server is stopped; it affects NEW runs after restart, never moves
existing legacy/concurrent mappings. Source code work does not authorize modifying
actual owner project files or starting/restarting any live service.

Tests: disposable real SQLite mapping + API/fake server, real temp settings files
and old/invalid-file compatibility, strict scope/conflict and readonly schemas;
UI fixtures for stale project/session/objective/send completions and safe retry,
role settings preservation/races and running locks. Use real Chrome desktop/mobile
fixtures where useful. Existing blocked hostile Git regression/probe must remain
excluded; no need to run unrelated acceptance/security suites. No deps, Git writes,
models/accounts/targets/shared services, or extra agents. Maintain
.agents/teamwork/cn14-owner-ui-20261027/brief.md/handoff.md. Report stable endpoint
shape early and freeze for independent API/UI review.
