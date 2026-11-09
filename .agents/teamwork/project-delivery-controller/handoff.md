# CN-09 handoff

Status: partial; frozen at root instruction after fresh five-hour quota reached 10 percent. No further feature work or delegation is authorized in this turn. CN-09 is not accepted without the pending controller scenario tests and independent review/challenge.

## Scope and constraints

Owned files: `src/delivery-inbox.js`, `src/lead-planner.js`, `src/project-delivery-controller.js`, `test/delivery-inbox.test.js`, `test/lead-planner.test.js`, and this ignored note directory. Root owns Git/docs. No live service, model, network, target, shared DB, account, or Git action occurred. SQLite use was in-memory only; planner used injected fake turns.

## Current APIs and behavior

- `DeliveryInbox(db,{projectId,sessionId,objectiveId,now,maxPending,authenticateOwner})`: synchronous `receive`, `pending`, `get`, `isAuthenticatedOwnerMessage`, `markApplied`, `markBlocked`, `signal`, `consumeTriggers`, and `projection`. Receipt persists before returning acknowledgement; duplicate ID/content returns the same receipt, conflicting content rejects. Owner correction authentication is an injected callback; caller-supplied flags do not grant owner authority. Message payload max is 16 KiB; received queue max is bounded to 256.
- `LeadPlanner({store,inbox,runTurn,settingsFor,contextFor,reconcilePriorTurn,providerThreadId,now,maxEvidence})`: `run(trigger)`, `projection`, `listEvidence`. Builds bounded projection and pins plan/goal/authority/control/inbox revisions plus settings/provider context. A provider-thread fence is durable. Output requires exact captured expected revisions; CAS checks current rows/inbox version inside an immediate SQLite transaction before applying raw `BacklogStore.applyPlan` delta. Stale result is retained as bounded evidence. Existing active/unknown provider turn blocks unless an injected reconciliation says `no_effect`.
- `ProjectDeliveryController({store,executor,projectId,objectiveId,sessionId,inbox?,planner?,runTurn,...,schedulerOptions,authenticateOwner,now})`: `start`, synchronous `receive`, `wake`, `runOnce`, `stop`, `status`. Scheduler admission checks pending messages through its synchronous policy within the backlog claim transaction. Settled executor outcomes signal planner wake. Owner corrections call only `store.applyOwnerCorrection` after authenticated inbox receipt; missing/failing extension blocks the message. Steering messages are marked applied after a successful captured turn.

## Verification

- `node --check src/delivery-inbox.js && node --check src/lead-planner.js && node --check src/project-delivery-controller.js && node --check test/delivery-inbox.test.js && node --check test/lead-planner.test.js && node --test test/delivery-inbox.test.js test/lead-planner.test.js`: passed; 6 tests, 0 failed.
- Tests cover durable/idempotent inbox receipt and received/applied distinction; auth callback enforcement and bounds; plan successor application; inbox-version stale-turn rejection; durable same-thread overlap blocking and idle no-trigger behavior.
- Earlier first run found normalized delta was passed back into an API requiring the raw wrapper shape; fixed and the exact gate above passed.

## Pending / risks

- `test/project-delivery-controller.test.js` is not implemented. Required controller scenarios remain unverified: ack during slow worker + concurrent lead turn, owner correction invalidation and same-transaction claim fence, completion unlock without poll loop, restart/lost-wakeup, bounded investigate/replan, and no-ready-work idle cause.
- Owner extension integration was coordinated with backlog_store owner: `applyOwnerCorrection(projectId,objectiveId, correction)` exact fields are sourceMessageId, expectedGoalRevision, expectedAuthorityRevision, expectedControlRevision, requirementDigest. BacklogStore callback `ownerCorrectionAuthorized({projectId,objectiveId,sourceMessageId,correction})` must independently authorize. Current controller passes `message.payload.correction` plus source ID without whitelisting fields; store validation must reject extras. Integration test with the actual extension is pending.
- CN-10 checkpoint inventory integration is not wired here; planner currently captures the store projection supplied by `getObjective`.
- No candidate review API is used. No runtime route/server activation exists.
- Concurrency risk: on process crash an `active` planner turn remains fenced; current recovery path requires injected `reconcilePriorTurn` to say `no_effect`, but not enough fault-injection tests exist. The wake trigger representation and multi-message acknowledgement need challenger coverage.
- Controller source has not had direct controller tests or independent code review. Review/challenge freeze remains required.

## Next concrete action

After root clears the quota freeze, finish only authorized CN-09 scope: add controller tests with actual BacklogStore/TaskScheduler/TaskExecutor-compatible fakes and barriers, tighten correction payload projection if the extension gate permits, run the focused scheduler/executor/backlog/inbox/planner/controller suite, then freeze for independent authority/concurrency review and challenge. Do not mark complete before those gates.
