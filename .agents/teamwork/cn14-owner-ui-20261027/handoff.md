# CN14 owner UI handoff

Endpoint contract is recorded in `brief.md` and confirmed by root on 2026-10-27. Review follow-up: root supplied four findings and a replay/CAS contract clarification; the referenced review handoff/report files were absent from the workspace, so fixes followed the findings in the root message.

Scope: `src/launcher-app.js`, `src/launcher-project-settings.js`, `launcher-ui/backlog.js/html/css`, `launcher-ui/roles.js/html/css`, and dedicated owner delivery/settings tests.

Verified after review fixes: `node --test test/launcher-app.test.js test/launcher-pause.test.js test/launcher-backlog-ui.test.js test/launcher-role-page.test.js test/launcher-owner-delivery.test.js test/launcher-owner-ui.test.js` passed 66/66. Fixtures cover exact run mapping, old backend unavailability, backend-authoritative stale revisions and duplicate replay, acknowledgement validation, readonly DB schema, settings preservation/invalid files/0600/exact-stopped lock, scoped draft persistence, in-flight selection changes, frozen retry body, and setting response races.

Refrozen delta for independent review: engine setting PUT accepts only `status === 'stopped'`; steer proxy validates mapping and server scope but forwards revisions unchanged; both proxy and UI require the exact message ID, `acknowledged:true`, a known inbox state, and matching scope before treating a 200 as received; drafts and pending send records are keyed by project/session/objective; uncertain retries reuse every field of the original request body while later edits remain in the draft. Backend worker still needs to wire `/control/delivery/:runId` and `/control/delivery/:runId/steer`. No live service was started. Do not touch server/router/core/project-settings/role model or performance files.
