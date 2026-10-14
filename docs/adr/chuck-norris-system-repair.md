# Chuck Norris system repair agent

Status: implemented and independently accepted in disposable tests; live repair pending.

## Problem

The project coordinator can investigate a blocked task but its specialist agents
are bound to the target workspace. A defect in the hosting control plane cannot
be repaired by giving a project engineer a wider project-relative file scope.
Asking the owner to debug these defects interrupts work without granting the
team the missing system capability.

The target project may itself be an orchestrator. Routing depends on the
component that failed, not on words such as "orchestrator" in a task title.

## Decision

Chuck Norris is a separate system agent hosted by the launcher at
`/agents/chuck-norris`. His profile lives outside the project role catalog in
`profiles/system/chuck-norris.toml`. He appears separately in the launcher role
list. The default model is GPT-6.1 Sol at high reasoning effort. His role-card
modal saves model and effort to the system profile for all projects; restart
the launcher to apply them. His behavior is calm, decisive diagnosis and bounded repair,
with concrete checks and preserved authority boundaries.

Chuck receives a control-plane source copy in an isolated writer lane. The
service requires a passing confinement probe for the current runtime version
and refuses shared-workspace fallback. Only an allowlisted source patch can be
integrated into the control-plane repository. The system executor validates a
completed worker report, all required/reported checks, absence of pending
decisions/scope expansion and the reported file scope before integration.
Refused candidates remain isolated and inspectable. Persistent service tasks, usage,
writer records and the system credential remain outside the lane write root.
The service owns separate state and workspace locks and serializes repair turns.

System RPC uses its own bearer token. The project's ordinary A2A token does not
authorize system repairs. Credentials are not included in model inputs or
reports. This separates API capabilities; it does not claim an operating-system
identity boundary between processes running under the same local user.

Discovery and `GET /api/system-agent` describe the role without starting a
Codex turn. Execution initializes the service lazily. Stopping a project does
not delete the service's task history. Launcher shutdown cancels and settles
system executions before closing their database and App Server.

## Lead contract

A coordinator with evidence of a hosting control-plane defect returns
`action: "request_system_repair"` with bounded `systemInput` fields:
`incidentId`, `question`, `evidence`, and `relatedDecisionIds`. This action
carries no project assignments, finish claim, acceptance proposal or owner
question. Unused `systemInput` is null; legacy decisions default to null.

The graph checkpoints the incident before dispatch, sends it over A2A and
records the response in a separate system-results channel. An unresolved
project writer or review gate does not grant Chuck authority to change project
records. Related worker decisions remain open until the lead independently
resolves them from evidence.

The client journals a stable request identity before sending. It reconciles a
possibly accepted write by task or deterministic context identity and never
blindly resends an ambiguous writable submission. Unknown results remain
recoverable under that identity. Transport calls and cancellation are bounded.

A successful repair report requires a completed task, a valid worker report,
passing source checks, an integrated lane and authoritative known writer delta
within the service scope. Project acceptance checks are contextual evidence;
they are not run as source-repair checks in the control-plane directory.

Completed system evidence returns to ordinary project planning and fresh
verification. It never supplies a project verifier or auditor receipt, changes
pinned checks, clears unknown writers, grants more budget or accepts the goal.
Owner-only decisions retain the existing closed list and investigation rules.

## Pause, stop and reload

An owner pause prevents a pending repair from being submitted. If requested
during a repair, the graph waits for its safe boundary and preserves the pause.
Stop propagates cancellation without declaring ambiguous effects harmless.

A system failure, unavailable service, uncertain effect, budget wait or required
runtime reload parks the run as `system_repair`. It is a technical wait, not a
request for the owner to choose a repair or debug the system. Rechecking uses
the same request identity. Already completed incidents cannot be repeatedly
submitted as new repairs without new evidence.

Trusted `launcher-bootstrap.js` and `server-bootstrap.js` entrypoints capture
the identity helper and entry modules before compilation, then record actual
loaded module bytes and profile bytes consumed by the parsers. These root
bootstrap files are outside the fixed system repair write scope. Use
`npm run launcher` and `npm start`; managed project starts use the server
bootstrap. Direct legacy entrypoints cannot prove their own loaded bytes.

The same-task recheck compares the integrated source manifest with fresh
requester and launcher identities. Every process that actually loaded an
affected file must have a new generation and the expected hash. Never-loaded
candidates and loaded-but-uncaptured files are distinguished. Partial reload,
unknown coverage and mismatching hashes keep the technical wait. Manual
rechecks have no lifetime retry cap and never create a new writable submission.

Changes to loaded runtime source require a controlled restart. This change
reports `restart_required` and preserves the checkpoint; it does not restart
services automatically or treat a source patch as a running-code update.
Existing owner-paused and stopped sessions stay paused and stopped. Automatic
maintenance restarts require their own lifecycle design and verification.

## Verification

Use disposable repositories, state files and fake App Servers to verify the
separate workspace, isolated integration, credential separation, graph routing,
replay, stop/pause, failure and reload behavior. No existing project session or
live model call is required for these checks. A live repair remains a separate
runtime exercise and must not be inferred from stubbed integration tests.

Final isolated verification: full npm test with NODE_TEST_CONTEXT removed
passed 1129, failed 0, skipped 1 optional live probe (1130 total). Independent
critic APPROVE; five adversarial probes HOLDS, including failed-report candidate
retention. Frontend syntax and git diff --check passed. No live repair, model
call, existing project restart or session resume was performed.
