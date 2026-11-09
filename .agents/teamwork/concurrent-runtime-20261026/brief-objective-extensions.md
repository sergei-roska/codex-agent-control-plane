# Shared foundation extensions for CN-09/CN-10

Dispatch only after CN-08 local gate accepts its optional claim eligibility hook.
Project /home/sr/Projects/Workspace/codex-agent-control-plane. Read worker TOML,
access policy and AGENTS.md; root owns Git/docs. Own only src/backlog-store.js,
test/backlog-store.test.js and local objective-extensions/ notes. No other product
edits/Git/state/service/model/network/target changes. Other workers build CN-09
controller and CN-10 reviews against these specified interfaces. Preserve the
accepted scheduler hook and all existing API behavior.

Implement two narrow trusted-controller primitives, no general record setter:

1. `applyOwnerCorrection(projectId, objectiveId, correction)` accepts exactly
   sourceMessageId, expectedGoalRevision, expectedAuthorityRevision,
   expectedControlRevision and requirementDigest. Require an injected synchronous
   `ownerCorrectionAuthorized` callback to confirm the source message from the
   authenticated owner inbox; default false. An origin string in planner output
   is not authorization. This method is never a planner proposal tool.
   Under one immediate transaction: recheck authorization/revisions; reject
   terminal objective; validate new requirement digest; increment goalRevision
   and controlRevision exactly once; preserve checksDigest/authorityRevision and
   owner pause/budget/technical intent; block unstarted draft/queued/ready tasks
   with typed owner-correction replan cause (same contract revision, explicit
   operational state). Active contracts and terminal evidence stay unchanged.
   If old phase is validating, return to planning without overriding owner pause.
   Commit state and owner-correction event together. Same sourceMessageId and same
   correction are idempotent even if revisions advanced; reused source ID with
   conflicting content rejects. Do not reset a backlog or reopen accepted work.

2. Optional synchronous `checkpointInventory({projectId,objectiveId})` in store
   constructor contributes trusted minimal checkpoint references to the current
   projection, unioned with initially stored checkpoints. Validate bounded array,
   project/objective IDs and duplicate consistency; reject async/malformed data.
   This is read-only registry projection, not checkpoint acceptance. Existing
   `checkpointAccepted` continues to default false and must return literal true.
   Pure plan validation must see this exact inventory under its transaction so
   newly registered CN-10 checkpoints can be referenced without raw backlog SQL.

Use the current delivery validators for IDs/digests/records. Stable typed reasons,
finite bounds, no raw owner conversation in events or notes. Receipt/registry
providers share this database and are trusted callbacks; callers must not expose
these functions or authorization booleans as model-authored authority claims.

Tests: authorized correction CAS and rollback with events; source ID replay and
conflict; unauthorized/default denial; active task contract immutability; queued
work requires explicit revisioned replan after correction; owner pause remains;
checks/authority unchanged; terminal objectives reject; injected inventory allows
valid checkpoint dependency and rejects wrong IDs/async/duplicates/malformed data.
Run affected contracts/backlog/events/scheduler tests, syntax/format checks.
Create brief/handoff early and send exact API to CN-09/CN-10 owners when stable.
Independent authority/persistence review is required before accepting this delta.
