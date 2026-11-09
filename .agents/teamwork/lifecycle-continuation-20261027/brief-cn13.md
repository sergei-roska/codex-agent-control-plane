# CN-13: concurrent backlog and team visibility

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Node CommonJS, node:test,
Express launcher, vanilla browser JS/CSS. Read /home/sr/codex-home/agents/worker.toml
and /home/sr/codex-home/development-access.md before working. Reading these does
not install hooks/sandbox. Apply English and ASCII to all authored content.

Goal: implement CN-13 from docs/architecture/concurrent-harness/implementation-plan.md,
with accepted CN-09/CN-10 APIs. Persistent current source exists, but startup is
NOT wired to new engine. Observability must truthfully show unavailable/legacy
state without constructing stores or mutating data on a read. No live rollout.
Read current handoff .agents/teamwork/concurrent-continuation-20261026/handoff.md
and relevant foundation-api.md sections before targeted code exploration.

You own NEW src/delivery-visibility.js and its test, NEW launcher-ui/backlog.js
and optional backlog.css, narrow launcher-ui/app.js/index.html/styles.css hooks,
src/launcher-app.js read-only routes and their dedicated tests. No edits to
performance.js/performance.html/session-performance.js; preserve existing token
repairs and all unrelated dirty content. Root owns Git/tracked docs. CN-11 owns
backlog-store.js, project-delivery-controller.js, lifecycle and their tests. Do
not modify those APIs. CN-14 will own startup/routing/migration later.

Required behavior:
- Read-only project/objective-qualified paginated ready/blocked/active task
  projection. Durable counts, dependency explanations, live instance counts,
  known effective capacity, planner/inbox state. Unknown capacity/time/tokens
  remains null/unknown; do not fabricate zeros or imply source config is active.
- A user can see why an idle slot is not filled: dependency, resources, capacity,
  control, absent work and unresolved effects. Separate authoritative known facts
  from derived/unknown causes. Preserve actual attempt/context provenance.
- An additive launcher read endpoint and useful main UI backlog/team view for
  the selected project/session/objective. Preserve legacy response shapes and
  older DBs with absent optional tables. No constructor side effects on GET.
- Project/session changes clear old data; in-flight and poll responses cannot
  overwrite a newer selection. Cursor/pagination scope cannot cross projects or
  objectives. Bound query limits and malformed input, do not expose raw paths
  or credentials unnecessarily. No write controls added in this package.
- Preserve full-width Roles, left Connectors, sidebar width, account refresh and
  token UI. Follow existing layout and accessibility conventions.

Use actual disposable SQLite data created with accepted stores, read-only reopen,
API fixtures and realistic browser fixtures including delayed stale responses and
old schemas. Test code should assert behavior rather than mirror implementation.
Fake transport/browser only; no model calls, account actions, target edits,
service restart, live shared data mutation, dependencies or Git writes. Temporary
fixtures and owned local test servers are allowed.

No additional agents. Maintain .agents/teamwork/cn13-visibility-20261027/brief.md
and handoff.md with exact API, changed files, actual checks, pending criteria
and evidence. Tell root when implementation is ready for independent review.
