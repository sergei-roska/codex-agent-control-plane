# HAR-03 handoff

Status: diagnosis grounded; scoped role-policy repair in progress.

## Grounded findings

- `src/codex-app-server.js` sends `approvalPolicy: 'on-request'` and
  `approvalsReviewer: 'user'` on thread start/resume and turn start. Its
  `_declineServerRequest` rejects command and file approval requests, grants an
  empty permission set for permissions requests, and declines MCP elicitation.
  Decline provenance is recorded. Ordinary declined commands are not retried by
  this protocol handler; caller prompt/graph behavior remains to be traced.
- `src/acceptance.js` runs agent-proposed checks only through `appServer.execCommand`
  with a read-only-workspace, network-disabled sandbox and the workspace as cwd.
  They cannot write the workspace. An existing owner opt-in `acceptanceScratch`
  adds a per-run scratch directory as the only writable root, while ownerChecks
  execute on the host. Thus current defaults intentionally do not provide a
  writable test-artifact path.
- `profiles/agents/engineer.toml` instructs engineers not to bypass denied
  actions and to report needed choices or permissions. This preserves authority,
  but does not yet explain how to use a configured sandbox capability or stop
  after a definitive denial. Other role guidance still needs targeted review.
- `profiles/TEAM.md` permits workers to perform git actions only when the lead
  explicitly authorizes them. The engineer, recovery-engineer, and
  senior-engineer profile text overrides that rule with an unconditional ban on
  git state changes, so an authorized local commit is currently excluded by
  their role prompt.
- Read-only query of `.runtime/projects/c65886082e/state.sqlite` found in the
  latest 200 usage rows 7 blocked-hook events, 2 failed command events, and one
  engineer turn with one `item/commandExecution/requestApproval` decline plus a
  declined `/bin/bash` command event at the same timestamp. The refusal and
  item completion are separate telemetry events for the same turn; neither
  establishes a retry. Latest failed command summaries expose `/bin/bash` and
  only sanitized output, so they do not identify a specific socket or Git
  metadata cause. No token files were read.
- A check with source `agent` is run from `runAcceptance` via `execCommand` with
  network disabled and a read-only workspace. Existing owner-configured
  `acceptanceScratch` is already passed through as a single isolated writable
  root, with a per-run temp directory and `TEAMWORK_TEST_SCRATCH_ROOT` support.
  `ownerChecks` affects only new requests that omit checks; an existing agent
  contract remains pinned. There is no in-scope route to make a per-project
  network policy reach ordinary worker turns: that path is wired in
  `src/server.js`, `src/a2a-role-service.js`, and `src/lead-graph.js`, which this
  brief excludes. Enabling App Server network access broadly would not provide
  a loopback-only boundary.
- Initial git status has unrelated changes in `docs/orchestrator-improvement-backlog.md`
  and untracked `docs/harness-critical-incidents-2026-10-20.md`; these are lead-owned
  and will be preserved.

## Initial next step (completed, then expanded)

The role and scratch guidance work described above was completed. The lead later
authorized the cross-file native policy implementation described below.

## Implementation and verification

- Updated `profiles/agents/engineer.toml`,
  `profiles/agents/recovery-engineer.toml`, and
  `profiles/agents/senior-engineer.toml`: an exact lead-authorized local Git
  operation is no longer banned by the role text, but still requires the active
  App Server policy. Approval/sandbox denials are explicit terminal outcomes;
  host fallback or broader permissions are forbidden. Check authors are told
  to use configured `TEAMWORK_TEST_SCRATCH_ROOT` for generated final-check
  artifacts.
- Added `test/role-catalog.test.js` coverage for those boundaries.
- `node --test --test-name-pattern='implementation roles allow only explicitly authorized local Git actions and stop on denied operations' test/role-catalog.test.js`:
  1 passed, 0 failed.
- `node --test test/acceptance-scratch.test.js test/project-settings.test.js`:
  27 passed, 0 failed. This confirms existing safe scratch capability and
  default-disabled settings; no implementation change to scratch plumbing was
  needed.
- Broader exploratory command `node --test test/role-catalog.test.js
  test/acceptance-scratch.test.js test/project-settings.test.js` produced 37
  passed and 2 failed in unrelated existing role-catalog assertions about the
  shipped MCP allowlist and malformed allowlist parsing. Those profile/tool
  assertions do not touch changed instructions. The focused new role test and
  both scratch/settings files pass.

## Remaining gap

This partial change does not grant new OS/App Server capabilities. A safe
project-scoped network or Git-metadata capability cannot be wired without
`src/server.js`, `src/a2a-role-service.js`, and `src/lead-graph.js`, all excluded
by the brief. App Server's exposed `networkAccess` boolean is not loopback-only;
do not enable it globally as a workaround. Lead decision needed: authorize
scope expansion to design and implement a constrained policy route, or keep
the current network-disabled default and handle socket-dependent checks under a
separate supported test strategy. No live or host execution was attempted.

## Expanded implementation update (2026-10-20)

Root authorized implementation of native owner permission inheritance, with the user selecting configured project access for trusted local projects. The brief scope now includes `src/execution-permissions.js`, `src/server.js`, `src/a2a-role-service.js`, `src/acceptance.js`, `src/codex-app-server.js`, `src/app-server-switch.js`, `src/project-settings.js`, `src/writer-lanes.js`, and permission/acceptance/lane tests. Minimal `src/lead-orchestrator.js` and `src/lead-graph.js` parameter plumbing is authorized and coordinated; lead owns other graph edits. Do not edit tracked docs or Git.

Grounded native protocol facts from local `codex app-server generate-ts --experimental --out /tmp/codex-app-server-types` (schema generation only, no server/model turn): `thread/start`, `thread/resume`, `turn/start`, and `thread/settings/update` support named `permissions`; these cannot be combined with sandbox fields. `command/exec` supports `permissionProfile`, incompatible with `sandboxPolicy`. Effective config comes from `config/read`; `permissionProfile/list` returns `{data:[{id,description,allowed}],nextCursor}`. Root verified the actual active native config without a model call: default profile `:danger-full-access`, `approval_policy='never'`, trusted project, and all three built-in profiles allowed. Do not print full config or secrets.

Current code edits (not yet verified):
- `src/project-settings.js`: `executionPermissions` accepts `inherit|strict`, defaults to `inherit` including old valid version-1 files; invalid or unreadable existing files fall back to strict plus warning. Settings are not edited on disk.
- New `src/execution-permissions.js`: reads effective config and permission profiles via App Server, determines trust from canonical project roots with closest-ancestor precedence (or native workspaceTrust), and falls back to strict unless trusted and the active profile/profile list is usable. Returns only policy metadata, not config contents.
- `src/codex-app-server.js`: adds config caching, resolver support, modern profile selection, configured approval fields, and `thread/settings/update` for already loaded threads so old strict settings do not persist. It accepts `permissionWorkspace` so lane cwd does not replace trust root. Legacy mode maps to configured sandbox policy.
- `src/acceptance.js`: agent checks can omit sandbox override only when resolver confirms trusted inherit; otherwise strict policy remains. Check contract/source, pins, and snapshot gates are unchanged.
- `src/server.js`, `src/lead-orchestrator.js`, `src/lead-graph.js`, `src/a2a-role-service.js`: plumb owner setting; A2A passes original workspace as permission root and does not create a lane for `executionTarget:'shared'` (parallel agent owns schema/contract plumbing and group constraints).

Implementation now keeps strict lane probes available with the existing legacy sandbox contract. Trusted inherited `:danger-full-access` uses explicit cooperative lanes with no confinement claim; other inherited profiles use shared workspace mode. The account-switch wrapper forwards config and permission resolution. Production Lead, A2A, and agent acceptance paths pass the owner setting explicitly. Low-level `CodexAppServer.run()` defaults to strict for compatibility; strict resolution short-circuits before any config RPC or App Server start.

Loaded threads track the applied native permission and approval fingerprint. An unchanged policy needs no settings RPC. An unknown or changed policy is applied before the next turn, including strict-to-inherit transitions. Native profile wire fields are never combined with legacy sandbox fields.

## Verification update (2026-10-20)

- `node --test test/project-settings.test.js`: 13 passed, 0 failed. Missing and valid legacy settings inherit; corrupt, invalid, or unreadable existing settings warn and fall back to strict.
- `node --test --test-name-pattern='performs initialize handshake and completes a turn|pins approvalsReviewer to user on thread/start|inherits trusted native writer and inspector profiles on new and resumed threads|updates a loaded strict thread before using inherited native permissions|reuses the applied policy for a loaded thread without settings updates' test/codex-app-server.test.js`: 5 passed, 0 failed.
- `node --test test/codex-app-server.test.js`: 110 passed, 2 failed. Both failures match baseline c22528e: enumeration-failure tool overrides and selected-skills provenance. Cleanup, startup metadata, native wire profiles, strict-to-inherit transition, and same-policy continuation passed.
- `node --test --test-name-pattern='trusted native full access selects cooperative lanes without claiming confinement|mode selection: shared by setting, unsupported App Server, nested workspace, or a failing probe' test/writer-lanes.test.js`: 2 passed, 0 failed.
- `node --test test/app-server-switch.test.js`: 6 passed, 0 failed, including resolver/config forwarding.
- `node --test test/execution-permissions.test.js`: 6 passed, 0 failed (completion-owned test).
- Root verified production `runAcceptance` with a disposable trusted repo inherits `:danger-full-access` / `never`, binds loopback and accepts the result; native command/exec made a local commit in that disposable repo. No model turns. Root also verified actual `startServer` serves HTTP 200 with cooperative lanes labeled `confinement: 'none'`, then closes and removes the disposable workspace. Evidence is in `.agents/teamwork/harness-critical/native-development-evidence.json` and `native-startup-evidence.json`.
- `node --test --test-name-pattern='agent checks use native execution only after inherit is resolved|agent checks retain strict sandbox policy when native inheritance is not resolved|explicit strict acceptance keeps the exact scratch-only no-network policy' test/acceptance.test.js`: 3 passed, 0 failed (completion-owned tests).
- `node --test --test-name-pattern='shared execution target uses admitted workspace while the default target uses an available lane' test/a2a-role-service.test.js`: 1 passed, 0 failed (completion-owned test).
- `git diff --check -- <owned source and test paths>`: passed.

No saved settings, target workspace, live service, or active session changed. No paid model turn was started. No tracked documentation or Git operation was performed by this worker.
