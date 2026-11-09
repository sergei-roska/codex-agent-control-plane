# Verifier IPC runtime fix handoff

Status: source implementation frozen for independent review. No Git mutation,
target project edit, or service restart performed.

Implemented shared native and verifier policy helpers. Writable verifier turns
receive networkAccess=true for legacy workspace-write and strict sandbox routes;
read-only roles, ordinary roles, native danger-full-access semantics and modern
permission profiles remain unchanged. Continued threads apply the updated policy
through existing execution-policy digest reconciliation. Agent acceptance checks
use networkAccess=true in strict mode and legacy workspace-write, while preserving
empty writable roots or the configured scratch-only root, pins, admission and
candidate snapshot checks. Modern managed profiles are left intact; preflight
reports custom profile network capability as unverified and recognizes the
built-in :danger-full-access profile. Route identity includes the verifier IPC
network capability. Docs state that this grants general sandbox network access.

Verification:
- node --test test/acceptance.test.js: 53/53 pass.
- node --test test/verification-preflight.test.js test/execution-permissions.test.js: 13/13 pass.
- Focused Codex policy tests: 4/4 pass.
- node --check on changed source modules and git diff --check: pass.
- Full test/codex-app-server.test.js: 113/115; two unrelated failures in the connector enumeration fixture and stale skill ID fixture. Changed verifier tests passed.
- `node --test test/acceptance-scratch.test.js`: 15/15 pass; `node --test test/lead-graph.test.js`: 276/276 pass after updating network-access expectations while retaining root/env/exclusion assertions.
- Root runtime probe using the exported policy helper and AppServer command/exec: AnyIO portal and loopback bind passed; write outside workspace denied with EROFS; exit 0. Evidence: .agents/teamwork/ipc-runtime-fix/live-policy-probe.json.

Changed implementation files: src/execution-permissions.js, src/codex-app-server.js,
src/acceptance.js, src/verification-preflight.js. Changed tests:
test/codex-app-server.test.js, test/acceptance.test.js,
test/verification-preflight.test.js, test/acceptance-scratch.test.js, test/lead-graph.test.js. Changed docs: docs/execution-permissions.md.
Concurrent handshake/launcher changes in the shared checkout were preserved.

## Parent acceptance and runtime delivery

Independent critic APPROVE; final test-only delta also APPROVE. Challenger HOLDS:
real command/exec probes preserve empty and scratch-only writable roots, deny
workspace and outside writes, permit only configured scratch writes, and allow
loopback networking. Probe: challenge/boundary-probe.js.

Root full suite:1441 total,1428 passed,12 failed,1 skipped. Eight failure names
exactly match the accepted baseline. Three new failures were stale networkAccess
expectations; fixed and affected scratch15/15 and lead-graph276/276 suites pass.
One unrelated launcher startup test failed under full load and passed2/2 when
rechecked. Evidence: full-tests.log, test-comparison.json,
launcher-startup-recheck.log. This is not a clean full-suite claim.

Managed project server stop/start completed with no active runs. New PID168790,
moduleLoadedAt2026-10-22T07:07:51.640Z; all four loaded source hashes match disk.
See loaded-runtime.json. No launcher restart, Git mutation or target source edit.
Temporary target .codex/config.toml was removed; system code alone is active.

Started same-session follow-up e2c71938-b92f-4b70-a231-dc0088343016 in context
3ccf85ff-a20a-4eec-990e-ca54e99ec1dd, referencing terminal old run
bcc2e028-174d-42a9-86d3-56137df31600. Original bash scripts/ci.sh contract retained.
Lead owns target repairs and acceptance, first standard verifier IPC/API smoke.
Actual verifier deployment qualification is pending that one smoke outcome.
Sentry harness_sentry is gpt-6-luna/low, monitors read-only and reports only
new actionable Harness events, decisions, stalls and terminal results. It does
not send messages, change source/state or run target work. Owner's standing
scope: root debugs/improves Harness; target implementation belongs to its lead.

## Deployment qualification complete

Read-only sentry confirmed accepted standard verifier smoke at2026-10-22T07:11:28Z,
attempt e2c71938-b92f-4b70-a231-dc0088343016:r3:a0:t1,
checkpoint a3-standard-verifier-smoke. Actual standard lane used existing
.venv/bin/python; AnyIO returned portal-ok and both Host-guard API test nodes
passed (2 passed). filesChanged=[] and HEAD/dirty paths unchanged. This closes
IPC deployment qualification. It is not integrated A3 acceptance.

First smoke had encountered unwritable default uv cache; lead autonomously
adapted the command to the existing venv and succeeded. Root did not repair
target source or broaden sandbox grants for that routine environment issue.
Lead continues target work; low-cost read-only sentry remains active, waking
root only for actionable Harness defects, human decisions, stalls or terminal
results. System IPC implementation, review and runtime delivery are complete.
