# CN14 owner UI

Own launcher app delivery control and owner engine settings routes, Backlog steering UI, Roles engine selector, and dedicated tests.

## Endpoint contract

- `GET /api/projects/:id/delivery/control?objectiveId=...&sessionId=...` requires both scope IDs, derives the run only from the readonly `concurrent_delivery_runs` mapping, and forwards authenticated `GET /control/delivery/:runId`. It returns the plain `controlStatus` JSON only after exact engine/project/session/objective/run scope verification. Missing mappings and old server routes return an `available:false` reason.
- `POST /api/projects/:id/delivery/steer` accepts exactly `{runId,projectId,sessionId,objectiveId,messageId,text,expectedPlanRevision,expectedGoalRevision,expectedControlRevision}`. It requires a running project, verifies the exact mapping and current server scope, then forwards authenticated `POST /control/delivery/:runId/steer`. Scope mismatch returns 409; revision conflicts are decided by core after duplicate replay resolution.
- `GET/PUT /api/projects/:id/delivery-engine` reads or updates `deliveryEngine` while preserving the full validated project settings document. PUT is stopped-project-only and uses a 0600 temporary file plus rename.

## State

Review clarification: the launcher validates mapping and current scope but forwards the caller's expected revisions unchanged. Core must check exact durable message replay before revision CAS, so stale duplicates can receive their durable acknowledgement while genuinely new stale requests receive authoritative 409.

Implementation and review fixes are complete. Dedicated verification command: `node --test test/launcher-owner-delivery.test.js test/launcher-owner-ui.test.js`.
