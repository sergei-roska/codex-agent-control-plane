# Legacy qualification suite and launcher readiness repair

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read/apply
/home/sr/codex-home/agents/middle_worker.toml developer instructions and
/home/sr/codex-home/development-access.md. Root owns Git/docs. Allowed writes:
launcher.js, test/launcher-startup.test.js, test/a2a-role-service.test.js,
test/codex-app-server.test.js, test/role-catalog.test.js, test/writer-lanes.test.js,
test/e2e.test.js. Additional source only if root approves concrete evidence; report
necessary extra path before editing. Other workers own delivery engine/server/
executor/RoleService source/tests and new comparison test; do not touch those.
Evidence/handoff here; preserve snapshots of each allowed file before changes.
No Git mutation/live provider/existing service/settings/account/dependency changes.
Disposable local test servers/Git/SQLite/child fixtures allowed. ASCII English,
no quota notes. Existing Node CommonJS environment.

Purpose: full source qualification currently has eleven known failures. Read
../scheduler-rearm-20261028/verification-full.json/.tap for exact baseline. Resolve
stale tests against accepted contracts and actual launcher readiness race without
weakening assertions or production policy. Independently classify each failure;
known does not mean harmless. Do not change role config/allowlist/permissions.

Lead read evidence (verify before edits):
- launcher.js announces ready at line39, then installs SIGINT/SIGTERM at58-59.
Parent may SIGTERM immediately on readiness before handler exists (null code).
Install shutdown handling before announcing readiness. Existing startup test is
real end-to-end; add a meaningful deterministic ordering regression if practical,
without mirror tests or timeout increases.
- Continuation deep-equality failures show additive mcpToolPins:[] metadata.
Preserve thread/lane/home assertions and validate exact pins; do not drop equality.
A same-target verifier continuation additionally fails before provider boundary;
diagnose actual refusal and repair fixture or report source bug instead of merely
lowering expected calls or accepting rejection.
- MCP enumeration test expects permissive fallback while current _toolPolicy
fails closed. Verify current intended contract and update meaningful refusal test
(no provider turn, truthful enforcement failure); never relax enforcement.
- Skill fixture selects first catalog entry but hardcodes entity-query-analyzer;
current catalog first actor-model. Make fixture deterministic or bind assertions
to exact selected ID/hash while preserving scoped input/provenance checks.
- Shipped role tools test expects empty allowlists while accepted profiles contain
explicit curated harness servers; malformed fixture .replace('mcp_servers = []')
no longer edits anything. Validate actual intended static per-role contract and
construct truly malformed table; no tautological read-and-compare assertions.
- E2E restart copies DB from rootA to a different rootB workspace; new immutable
project identity correctly rejects. Preserve real same-workspace restart/no-resend
qualification and add/retain explicit cross-project refusal. Do not weaken guard.

Acceptance: all affected named legacy cases pass honestly, launcher ready implies
shutdown handler installed, meaningful source bug classified/repaired within allowed
scope. Run focused files/selected cases with env -u NODE_TEST_CONTEXT node --test;
root runs broad final freeze after all milestones. Report exact before/after facts,
all failures not fixed, source expansion requests and final handoff. No broad suite.
Any full/delivery-acceptance command MUST include exact exclusion:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Never run that named prohibited test. Keep existing verification strong; no
vacuous assertions, changed outcomes just to pass, or hardcoded production results.
User authorized autonomous complete plan. Independent review follows.
