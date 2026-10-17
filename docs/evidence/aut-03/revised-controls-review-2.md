# Independent AUT-03 control review 2

Status: APPROVE

Reviewed at: 2026-10-17T05:50:41Z

Source baseline: `main` at `ebe51c8f3a6139afa4141f116707d9c94e8be952`.

## Review result

The direct pinned Codex App Server instance used by the lead has the request and tool-policy hooks installed. The request hook observes every lead `turn/start`; it rejects the fourth submission before forwarding it. The breach schedules `SIGTERM`, and the server shutdown path cancels the run, bounds executor settlement and App Server shutdown, closes HTTP connections, and terminates the child process.

The prior worker-dispatch deviation and both outputs from revised cohort 1 remain excluded. The baseline gate remains false. Review did not start a task, service, or test, and made no model call.

The critic's independent static review checked 168 referenced file hashes with zero mismatches, four prompt hashes, both settings hashes, the declaration pointer, and the closed gate. A separate local validation checked 141 runtime source files, 2 binary pins, 2 helper pins, 16 input hashes, 4 prompt hashes, 2 accepted evidence files, current cross-document pointers, prior review and stop-report pointers, task evidence, and archived protocol snapshots with zero mismatches. `node --check` passed for both trial helpers, and `git diff --check` passed.

## Current execution state

At 2026-10-17T05:50:41Z, the launcher reported 37 percent primary usage and 84 percent weekly usage for the active Team account; automatic account switching was disabled. The trial declaration stops work at 85 percent weekly usage. Because only one percentage point remained before that stop threshold, the baseline gate was left closed and no task was started. Repeat quota, hash, and isolation preflight before any future task. Do not switch accounts.
