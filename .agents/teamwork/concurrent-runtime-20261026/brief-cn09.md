# CN-09: available lead, steering inbox and lookahead controller

Project /home/sr/Projects/Workspace/codex-agent-control-plane. Read worker TOML
developer_instructions/access policy under /home/sr/codex-work and project
AGENTS.md. Root owns Git/docs. Node24/deps available. ASCII English artifacts.
No real model/network/service/target/shared DB/account/Git actions. Fake model
turns and disposable SQLite only. Dispatch after CN-08 local gate is accepted.

Ownership: new src/project-delivery-controller.js, src/lead-planner.js,
src/delivery-inbox.js and corresponding three new test files; notes under
project-delivery-controller/. No backlog/scheduler/executor/candidate/review-policy
edits. Root assigns one separate owner for shared backlog extensions before
integration; report any needed API, never write another owner's source.

Read CN-09/local gate, target-design continuous planning/owner availability and
role-policy.md, then actual accepted scheduler/executor/store APIs and handoffs.
Legacy graph/prompts stay unchanged. This controller is a new explicit engine
composition boundary, not a legacy graph rewrite or live activation.

Implement durable project/session/objective inbox receipt and immediate ack while
workers or a planner turn run. Store bounded messages with received/applied/blocked
states and stable idempotent message IDs. Returned ack means received only. Version
the inbox and persist trigger reasons/cursor/wakeup; coalesce triggers, not distinct
messages/outcomes. No await of worker completion is allowed in message receipt.
Steering has priority before the next relevant claim via a synchronous scheduler
admission policy reading pending inbox state inside the same SQLite claim txn.
Status requests can read current projection without creating fake worker tasks.

Run short serialized lead turns through injected runTurn/settings/context adapter.
Pin task/evidence/goal/check identities, actual settings and provider context.
One durable active planner fence per project/session/provider thread; workers
cannot occupy reserved lead capacity. A short lead turn may overlap workers,
never another turn on the same provider thread. Plan triggers come from durable
events, new messages/objectives, eligible recovery or changed constraints; an idle
queue must not repeatedly call the model. Restart repairs lost wakeups from durable
pending state. Unknown prior planner effects are reconciled, not blindly replayed.

LeadPlanner builds a bounded consistent projection/prompt with queue, blockers,
accepted evidence, active attempts and current owner revisions. It accepts only
versioned plan deltas plus bounded dialogue/recovery/owner-decision metadata.
Validate model expected revisions against its captured snapshot AND recheck current
rows/inbox version under one immediate transaction before applying. A model cannot
guess a newer revision and thereby authorize a stale plan. Receipt of new steering
while a turn is running invalidates that turn's mutation authority even before
semantic interpretation. Keep its output as bounded evidence and wake a fresh turn.

Pure plan deltas cannot succeed tasks, grant publication or rewrite active work.
The lead may choose roles/team/pipeline below configured ceilings; templates are
suggestions. Ordinary implementation/scope blockers go to bounded internal
investigation/replan, not a generic owner question. Retain successful sibling
evidence. Two failures of one hypothesis require a different bounded plan; finite
internal exhaustion is resumable technical blockage, never goal completion.
Only existing closed owner-required reasons justify waiting_owner. New tasks and
reviews must have actual acceptance purpose, not be invented to keep slots busy.
Full final acceptance is CN-12; no free-text planner finish may bypass it here.

Shared backlog extension contract (separate owner, injectable for your local gate):
- applyOwnerCorrection(projectId, objectiveId, correction) CASes expected goal,
  authority/control revisions, pins sourceMessageId and a requirementDigest,
  increments goal/control revisions, preserves checksDigest and authority, and
  blocks unstarted tasks for explicit replan. Active contracts remain immutable.
  Terminal objectives cannot reopen; repeated identical message is idempotent,
  conflicting message identity rejects. Actual owner pause is not auto-resumed.
  Only authenticated owner-origin correction reaches this method; planner output
  cannot change owner checks or grant authority. Include source message evidence.
- Optional synchronous checkpointInventory lets the CN-10 registry contribute
  checkpoint IDs without direct SQL writes to backlog metadata. No hard CN-10
  dependency at this local gate; injected fake inventory is permitted.

Use fake barrier tests with actual SQLite/store/scheduler where interfaces exist:
receipt/ack and a lead turn while slow worker remains active; owner correction
invalidates old planner and blocks new relevant claims; plan adds successor while
workers continue; one provider thread never overlaps; completion independently
unlocks work without a planner poll; lost wakeup/reopen; bounded failed-worker
investigate/repair with unrelated progress and no owner reply; no-ready-work has
clear cause and no model loop. Verify received/applied distinction and exactly-once
message application. API should support controller start/wake/stop, inbox receipt,
status projection and injected final-acceptance hook for later CN-12.

Create brief/handoff early, send stable API and missing dependencies to root,
run focused meaningful tests/syntax/format checks and freeze for independent
concurrency/authority review. Do not claim installed server routing or live L6.
