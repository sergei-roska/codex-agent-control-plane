# CN14 host controls and provider identity preparation

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read
/home/sr/codex-home/agents/worker.toml developer_instructions/development-access.md.
English/ASCII, Node CommonJS/node:test/Express. Root owns Git/docs, preserve dirty
source. Initial ownership ONLY NEW src/delivery-host-controls.js and test, NEW
src/delivery-provider-identity.js and test. No server/bootstrap/router/core/UI edits
until root explicitly grants the next composition milestone. No extra agents.

Read ../cn14-host-map-20261027/brief.md and current engine public controls/router
APIs. Core worker owns concurrent-delivery-engine.js/test; UI worker owns launcher
API/proxy and Backlog/Role pages. Coordinate schemas via root, not overlapping edits.

Implement reusable authenticated host control registrar matching FIXED contract:
GET /control/delivery/:runId returns plain current core controlStatus JSON; POST
/control/delivery/:runId/steer accepts exact {runId,projectId,sessionId,objectiveId,
messageId,text,expectedPlanRevision,expectedGoalRevision,expectedControlRevision}.
Router's persisted engine mapping is authoritative; require scoped project/run/
objective/session match and concurrent engine. Existing bearer auth must precede
control access; validate input bounds/safe integer revisions/plain fields.
Scope mismatch/missing maps fail closed; stale version409, unavailable legacy
clearly typed, no arbitrary engine fallback. Call actual core steer once; relay
durable received acknowledgement without waiting for planning/model execution.
Preserve received versus applied. Do not infer model-provided owner authority.

Implement read-only capture of pinned provider identity from an explicit trusted
Codex home. Root verified ONLY metadata presence: current auth.json has nonempty
tokens.account_id. Never print/read out credentials, never persist whole auth JSON.
Read bounded local auth metadata privately, use opaque SHA256 identity for account
and canonical real home; no email identity, guesses, account switching or fallback.
Allow injected loader/identity for disposable tests. Generic typed errors must not
include raw JSON/token/credential data. Expose a synchronous fresh identity getter
for later engine composition to detect same-home account replacement before
provider work. Do not mutate process.env, credentials, profile or account state.
Actual settled provider home must be supplied by server adapter, not selected here.

Test helper behavior with fake metadata in owned temp homes ONLY, no actual account
reads in tests. Control tests use real Router/SQLite and fake engine or current
core as practical; actual Express auth/HTTP, wrong scope/engine/revision/malformed
input, durable immediate ack during held fake turn, safe duplicate input and no
extra provider sends. No live models/providers/accounts/shared services/target/
dependency/Git/restart actions. Test fixture own servers allowed. Maintain
.agents/teamwork/cn14-host-prep-20261027/brief.md/handoff.md and report stable API.
Do not wire startServer until root grants after core gate; prep itself is not CN14
activation. Native13:45:34Z84%primary36%weekly (root will recheck before dispatch).
