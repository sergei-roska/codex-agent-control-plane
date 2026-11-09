# CN-13 visibility rework handoff

Status: all seven independent-review blockers addressed; ready for the next review. The review report is `.agents/teamwork/cn13-review-20261027/report.md`.

## Changes made

- `src/delivery-visibility.js` now conservatively projects task readiness. Checkpoint acceptance remains unknown because no readonly trusted acceptance adapter is exposed. Task-output dependencies are ready only when a matching succeeded attempt has trusted outcome, exact task revision, settled remote/process/effect facts, and matching output contract. Explicitly untrusted or mismatching output blocks; missing proof is unknown.
- Capacity and role occupancy use live claims across every objective in the project. Task ready/blocked/active/unknown counts remain scoped to the selected objective. Configured project/objective ceilings are separately labeled from unknown effective runtime capacity.
- Planner activity is labeled session-scoped and explicitly unattributed to an objective. Inbox state remains objective-scoped.
- Pagination uses an opaque base64url cursor bound to project, objective, and optional session; mismatched scope is rejected.
- Added readonly `GET /api/projects/:id/delivery/objectives` for objective selection; no user entry of internal objective IDs is needed. Both visibility routes query optional tables directly without constructing stores or mutating schema.
- Backlog UI has an objective selector, 5-second refresh, generation checks for project/session/objective changes, detailed role occupancy and known/unknown idle causes, plus distinct configured and effective capacity labels.

## Verification

`node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js test/launcher-app.test.js` - 48 passed, 0 failed.

The scenarios include trusted/missing/untrusted dependency evidence, unknown checkpoint acceptance, two objectives sharing project/role capacity, session-wide planner labeling, cursor scope rejection, objective-list route, readonly old-schema behavior, and delayed responses across objective/project/session changes with live polling. Also passed `node --check` for changed JS files and `git diff --check`.

## Scope and limits

No backlog/controller/planner/executor source, performance source, startup routing, dependencies, or tracked docs were changed. Runtime scheduler admission and checkpoint acceptance callbacks remain unknown because accepted readonly APIs do not expose them. The projection conservatively under-claims readiness when persisted evidence cannot prove the condition. No service restart, account action, model call, target edit, or Git mutation was performed.

Changed owned files: `src/delivery-visibility.js`, `src/launcher-app.js`, `launcher-ui/app.js`, `launcher-ui/index.html`, `launcher-ui/backlog.html`, `launcher-ui/backlog.js`, `launcher-ui/backlog.css`, `test/delivery-visibility.test.js`, `test/launcher-backlog-ui.test.js`, `test/launcher-app.test.js`.

## Follow-up for second review

Fixed the two UI behavior blockers and theme mismatch:

- Polling now refreshes every page already loaded for the selected objective. It preserves the current selection and is bounded to 10 pages/1000 tasks; the Load more button disables at that cap. The nonempty cursor path is covered by a browser-style VM regression.
- Summary now reports unknown readiness separately from blocked tasks.
- Backlog CSS uses the launcher theme's `--text-main`, `--bg-surface`, `--border-card`, and `--bg-card` tokens. Buttons use the established launcher button classes. Dependency detail rendering tolerates both API `reason` and fixture `detail` fields.

Latest focused check: `node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js test/launcher-app.test.js` - 49 passed, 0 failed. `node --check launcher-ui/backlog.js`, `git diff --check`, and the ASCII scan passed.

Real Chrome fixture command: `python3 .agents/teamwork/lifecycle-continuation-20261027/browser-fixture.py`. Computed evidence: desktop text `rgb(237, 237, 242)`, body background `rgb(10, 10, 15)`, header background `rgb(16, 16, 22)`, document width1434/viewport1440; mobile same theme colors, document width390/viewport390. Both rendered 2 task rows with the selected objective and no JavaScript exceptions. Screenshots and JSON evidence are under `.agents/teamwork/lifecycle-continuation-20261027/browser/` and may be removed with temporary teamwork data. Screenshots were visually inspected at desktop and mobile sizes.

No project service was restarted; the browser fixture used its disposable local HTTP server and temporary Chrome profiles. No performance source or CN-11-owned modules were touched. Status is ready for independent re-review.

## Narrow task-label follow-up

Valid delivery/v1 task records do not include a `title`; the readable task summary is now derived from `task.objective`, whitespace-normalized, trimmed, bounded to160 Unicode code points, and ellipsized when truncated. Empty/legacy objective text falls back to the stable task ID. The projection continues to return `taskId`; the UI shows that ID beneath the summary when they differ, using `textContent`.

Regression coverage creates a real valid task through `BacklogStore`, asserts its readable normalized summary is bounded and its exact task ID remains present, and checks the rendered task cell contains both summary and ID.

Latest focused command: `node --test test/delivery-visibility.test.js test/launcher-backlog-ui.test.js test/launcher-app.test.js` - 50 passed, 0 failed. Syntax checks, ASCII scan, and `git diff --check` passed. This follow-up changed only the owned projection/UI/test files plus this handoff.
