# System IPC repair evidence

Owner explicitly requests a permanent fix in this control-plane repository.
Root owns coordination/runtime lifecycle; ipc_runtime_fix worker owns the bounded
implementation after design agreement. Preserve concurrent handshake changes.

## Confirmed diagnosis

- Project server PID 28350 listens on 127.0.0.1:3004, cwd this repository.
- Target workspace: /home/sr/Projects/Workspace/claude-harness.
- Server environment lacks CODEX_HOME. Active account profile is null.
- Effective server profile is /home/sr/.codex: trusted target project, legacy
  workspace-write, approval on-request, auto_review, no sandbox_workspace_write
  before temporary local configuration.
- The helper uses /home/sr/codex-work with different native permissions. Helper
  capability must not be claimed as evidence for the verifier lane.
- Existing CodexAppServer command/exec reproduces running asyncio loop wakeup
  socket EPERM under workspaceWrite/networkAccess=false, exit13. Changing only
  networkAccess=true returns wakeup_bytes1 and callbackTrue, exit0. No model turn.
- Temporary target .codex/config.toml now contains only:
  [sandbox_workspace_write]
  network_access = true
  Effective native resolver confirms this setting. Remove it once the permanent
  system route is qualified. No original target config existed at that path.
- This setting permits network as well as IPC; it does not grant full filesystem
  access. Permanent behavior must state the policy boundary honestly.

## A2A coordination

Run bcc2e028-174d-42a9-86d3-56137df31600, context
3ccf85ff-a20a-4eec-990e-ca54e99ec1dd, decision h1.
Owner-authorized peer selected repair_standard_route and asked lead to stop
repeated probes/checks/reviewer dispatch until concrete route evidence arrives.
The original required check remains bash scripts/ci.sh timeout600000.
Checkpoint a3-resumed-integrated-acceptance still needs fresh candidate-bound
verifier and auditor receipts. Historical eight CI failures remain unresolved.
No acceptance gate was weakened and no acceptance claimed.

## Constraints

No changes to target source, global Codex config, authentication, Git history,
receipt DB, or owner contract. No service restart so far. Source edits must
preserve dirty launcher and handshake work. Required final qualification:
actual standard verifier IPC callback, filesystem negative control, current CI
and review behavior, and verified loaded runtime identity if code is reloaded.

## Coordination update

Root requested a graceful task pause through /control/pause before loading
system changes. Active host owner acceptance command was already running:
PID70124 bash scripts/ci.sh, PID70205 pytest. Do not kill it or infer its result.
The task's original check runs automatically after the lead proposes completion.
Wait for its terminal/paused boundary before managed project restart.

Root removed the temporary target .codex/config.toml before completion of the
existing host acceptance run. Target configuration is restored to its entry
state. Permanent qualification must use the system implementation alone.

## Owner scope clarification

Owner instructs root to debug and improve Harness itself, delegating target
project work to Harness's own lead. Do not fix claude-harness source regressions
from the host peer. After system fix acceptance and managed reload, continue the
same lead session with the old terminal run reference, unchanged CI requirement,
and current system evidence; observe orchestration and repair hosting defects.
Old run is now terminal completed/partial. Its fresh owner CI result is eight
failures, 2813 passed, 29 deselected in315.30 seconds. Verifier remains pending.
