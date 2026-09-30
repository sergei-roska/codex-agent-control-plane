# Hardening spec: writer admission, reconciliation, acceptance, usage

Status: implementation spec, written by the reviewing lead (Claude). It extends
`resilient-orchestration-spec.md`; where the two disagree, this file wins.

## 1. Workspace-wide writer admission

| Topic | Decision |
| --- | --- |
| Chokepoint | The role executor (`src/a2a-role-service.js`). Every Codex worker turn passes through it, whether a lead run dispatched it or a client called `/agents/<role>` directly. |
| Key | Canonical workspace (`fs.realpathSync`). |
| Storage | `writer_executions` and `writer_fences` tables in the state database (`src/writer-admission.js`). A partial unique index allows at most one `active` or `unresolved` holder per workspace. |
| Read-only roles | Never take admission; they run concurrently with a writer. |
| Waiting | A writer waits FIFO while the holder is `active`. It stays `SUBMITTED` until admitted. Cancel while waiting ends `CANCELED` with no effects. |
| Blocked | While the holder is `unresolved`, the executor tries one reconciliation; if it fails, the new writer ends `FAILED` with `failureKind: "admission_blocked"` and `effects: "none"`. |
| Release | Only when the turn ended with a confirmed terminal (`turn/completed` observed) or never reached `turn/start`. A task marked failed with an unknown outcome is not a release. |
| Cross-process | A second server on the same workspace is refused by a workspace lock. The lock is a kernel-held SQLite exclusive transaction (`BEGIN EXCLUSIVE`, `busy_timeout = 0`) kept open for the holder's lifetime; the kernel drops it when the process dies, so there is no stale-lock takeover. The lock identity is the realpath of `git rev-parse --git-common-dir` (non-git: the canonical workspace). Default file: `<git common dir>/codex-a2a-writer.lockdb`, shared by every workspace in the repository (nested workspaces such as `/repo` and `/repo/sub` exclude each other). With `CODEX_A2A_WORKSPACE_LOCK_DIR` the file is `<dir>/codex-a2a-writer-<sha256(identity)[0:16]>.lockdb`, so nested workspaces still collide; non-git without an override uses the OS temp dir. The state lock is `<stateFile>.lockdb`. Old `*.lock` text files are ignored. |

Every writer execution records a workspace snapshot before and after
(`src/workspace-snapshot.js`: git HEAD, porcelain status, content hash of every dirty or
untracked path). The delta (`changedPaths`) is attested by the server, not reported by the
worker. It is attached to the worker task as `writerExecution` metadata. Ignored files are
invisible to the snapshot.

## 2. Reconciliation after unknown writer outcomes

Quiescence (the earlier writer cannot mutate the workspace any more) is established
mechanically, never by a model or by a read-only inspection:

- no `turn/start` was recorded for the execution: no turn could run;
- the App Server child that hosted the turn led its own process group, and that group is
  gone (`src/process-quiescence.js`). The client terminates the child on every
  outcome-unknown path, so this usually holds within seconds. An orphaned group from a dead
  server process is killed only when its identity (pid, start time, parent) matches;
- a lost submission (journal `submitting`, no task) is fenced: its `contextId` goes into
  `writer_fences` and the executor refuses it at admission. If no execution row exists for
  that context at fence time, and the outcome proves no task was created (no `taskId`), the
  assignment never ran and never will.

If quiescence cannot be proven, the holder stays `unresolved` and blocks all writers.

Lead graph (`src/lead-graph.js`):

- `verify` adds every writable outcome that is not provably settled to the checkpointed
  `unresolvedWriters` list. Settled means `writerExecution.state` is `released` or
  `reconciled`, or the failure metadata says `effects: "none"`. Anything else, including an
  outcome without `writerExecution`, is unresolved.
- A deterministic `reconcile` node runs after `verify` whenever `unresolvedWriters` is not
  empty. Per entry: execution row found and settled -> resolved with its delta; `unresolved`
  -> `admission.reconcile`; `active` -> bounded wait; no row -> `fence`, then resolved as
  `never_executed` if still no row and no task existed. If a task existed but no execution row
  does (a checkpoint from before writer admission), the entry resolves as `legacy_unverified`
  with `deltaKnown: false`, `changedPaths: []`, reason `no_execution_record`; the writer is
  treated as having run, so acceptance reports `delta_unknown` and cannot accept. Each result is appended to `outcomes` as a
  `reconciliation` outcome with the attested `changedPaths`, so the lead sees the effects
  before it decides.
- Anything still unresolved -> `interrupt({ kind: "writer_unresolved", ... })`; the lead task
  is `INPUT_REQUIRED`. A resume re-runs the node (fence and reconcile are idempotent).
- `validateDecision` rejects a dispatch containing a writable role while
  `unresolvedWriters` is not empty, and `dispatch` refuses to submit a writable item in that
  state. Both are defense in depth: the graph reaches `decide` only after `reconcile`.
- Restart: startup reconciliation marks stale `active` rows `unresolved` and tries them; the
  resumed run then passes through `verify` and `reconcile` as above.

## 3. Workflow completion versus verified acceptance

- Contract: the first message of a lead run may carry
  `metadata.acceptance = { requiredChecks: [{ id, argv: string[], timeoutMs? }] }` from the
  authenticated caller. It is validated (unique ids, non-empty string argv, at most 10
  checks, timeout default 10 min, max 30 min) and pinned in graph state at intake. Resume
  messages and the lead model cannot change it. CLI: repeatable `--check '<command>'`, split
  on whitespace into argv; no shell.
- `accept` node, deterministic, between a `finish` decision and `finish`. It takes writer
  admission (role `acceptance`) so no writer changes the candidate, snapshots, runs each
  required check with `execFile` in the workspace (own process group, killed on timeout),
  snapshots again, and releases. Each check's process group is killed after the process
  exits, so no descendant can change the workspace after the second snapshot. A turn start with
  a null identity is recorded before each spawn, so a crash in that window leaves quiescence
  unproven. Aborting the run kills the running check group and yields `unverifiable` with
  issue code `acceptance_canceled`.
- Disposition, computed in code only:
  - `accepted`: every required check exited 0; the snapshot is a git snapshot and unchanged
    across the checks; no unresolved writers; every writable outcome that completed has a
    valid report; no attested scope violation (a `changedPaths` entry outside that
    assignment's `allowedFiles`, or an unknown delta for a writer that ran); no reported
    scope violation.
  - `rejected`: required checks exist and any condition above fails; `reasons` lists each.
  - `unverifiable`: required checks exist but no git snapshot is available.
  - `unverified`: no required checks and at least one writer ran; `issues` lists the same
    conditions without changing the status.
  - `not_required`: no required checks and no writer ran.
- A rejected acceptance returns to `decide` once with the acceptance record as a note; the
  second rejection finishes the run. The workflow status stays `completed`;
  `result.acceptance` carries `{ disposition, reasons, issues, candidate, checks }`, where
  `candidate` is `{ head, fingerprint }` and each check has exit code, signal, duration,
  and output tails. Worker-reported checks stay advisory.
- `verifyCandidate(workspace, acceptance)` recomputes the snapshot so a consumer can detect
  a candidate that changed after verification.
- A2A: the lead artifact metadata carries `acceptance`; CLI exits 4 for `rejected` and
  `unverifiable`.

## 4. Hook and permission denial provenance

Root cause of the observed denials (2026-09-29, proven from rollouts, guard telemetry, and
source; no Codex turn was run for this): the only hook in force is the user-level
`~/.codex/hooks/guard.py` (PreToolUse, matcher `^(Bash|apply_patch)$`). Its `is_worker()`
treats a thread as a worker only when the rollout `session_meta` has `parent_thread_id`,
which only Codex-native subagents have. A2A threads (originator `codex-a2a-runtime`) are
therefore judged by the lead rules:

- `apply_patch` to any workspace file other than `.claude/`, `.codex/`, or docs
  (`.md`, `.mdx`, `.txt`, `.rst`) is denied, whatever the sandbox. This denied the writable
  worker's edit of `src/codex-app-server.js` (two occurrences).
- Bash with an inline interpreter (`python3 -c`, `node -e`, `sh -c`, heredoc), `sed`/`perl`
  followed by any `-i` token, or a bare write-command token (`install`, `rm`, `touch`, ...)
  is denied. This denied read-only inspection commands such as `git show ... | python3 -c`.
- The deny reason carries only the short reason text, so the message cannot be attributed
  to guard.py without these records.

None of the observed denials came from the sandbox or the approval policy. The fix belongs to
`~/.codex/hooks/guard.py`, outside this repository: classify A2A worker threads (for example
by `session_meta.originator`) and name the guard and rule in the deny reason. This repository
does not change permissions, does not disable or bypass the guard, and does not change how
workers identify themselves.

The client pins `approvalsReviewer: "user"` on thread/start, thread/resume, and turn/start so
an `auto_review` reviewer in the user's Codex config cannot approve sandbox escalations; the
client declines every approval request.

What this repository adds is observability. The App Server client records sanitized
`permissionEvents` per turn (`hook/completed` runs that block or report stop, feedback, or
error; declined or failed tool items; output starting with "Command blocked by PreToolUse
hook:"; non-approved auto reviews; approval requests the client declined), together with
`permissionConfig` (sandbox, sandbox policy type, approval policy, approvals reviewer, cwd). The role executor
attaches both, with role, task, context, and workspace, to the worker task metadata and the
usage ledger. `listHooks(cwd)` exposes the App Server hook inventory (`hooks/list`). Whether
`hook/*` notifications arrive without the `experimentalApi` capability has not been verified
live.

## 5. Usage accounting

- The App Server client attaches `usage` to every run: model, effort, start, elapsed,
  turns, model requests, per-turn tokens derived without double counting, token source,
  raw cumulative total, App Server version. Unknown values are `null`, never 0.
- Ledger table `usage_ledger` in the state database, one row per Codex turn, insert-or-ignore
  on a stable key so resume and re-collection never double count: worker turns are written
  by the role executor (`<role>:<taskId>`), lead turns by the lead graph
  (`lead:<threadId>:<turnId>`). Runs are linked to worker turns through the dispatch
  journal (`task_id`).
- Cost is always `null` with basis `subscription`. `npm run usage` prints measured usage per
  run, role, and attempt; an optional price table computes a separately labeled
  hypothetical API cost.
- `docs/efficiency-comparison.md` describes how to compare native subagents with A2A on the
  same task, models, effort, permissions, and acceptance checks. No efficiency claim
  without measured results.

## 6. Tool surface

Each role profile declares `[a2a_tools]` (`mcp_servers` allowlist, `skills` boolean); a missing table is deny-all. `CodexAppServer` sends a `config` override on every `thread/start` and `thread/resume`: `features.apps=false`, `features.plugins=false`, `skills.include_instructions=false` and `skills.bundled.enabled=false` (unless the role sets skills), and `mcp_servers.<name>.enabled=false` for every server returned by `config/read {cwd}` that is not allowlisted. Enumeration is cached per child generation and cwd. The result is recorded as `permissionConfig.toolPolicy` (`mcpAllowed`, `mcpDisabled`, `mcpMissing`, `skills`, `apps`, `plugins`, `enforced`, `source`, and `reason` on failure) and flows into worker provenance and the usage ledger. If enumeration fails, the other overrides are still sent and `enforced` is false; this is a cost control, not a security boundary, so the turn is not failed. Sandbox and approval settings are unchanged.

## Known limits

- A tool process that leaves the App Server process group (setsid, setpgid, daemonizing)
  escapes the quiescence proof.
- An orphaned process group whose leader died is never killed automatically (the group id
  may have been reused). The writer stays unresolved (`quiescence_unproven`) and reconcile
  returns the surviving members (`survivors`: pid, comm) for the operator to act on.
- Ignored files are invisible to workspace snapshots.
- The workspace and state locks need a filesystem with working POSIX locks (not some
  network filesystems) and a shared view of the repository's git dir.
- Deleting a lock file while it is held defeats the lock (inherent to file locks). A lock
  file that is read-only or unwritable is refused at acquire.
- `CODEX_A2A_WORKSPACE_LOCK_DIR` and the default location (`codex-a2a-writer.lockdb` in the
  repository's common dir) are different files, so all servers for one repository must use
  the same setting.
- Acceptance argv runs on the host outside the Codex sandbox. Keep the bearer token file
  outside the workspace (`CODEX_A2A_TOKEN_FILE`) when workers can read the workspace.
- `legacy_unverified` outcomes from checkpoints that predate writer admission cannot be
  accepted; their delta is unknown.
- The lead read-only role and the workers depend on the `~/.codex/hooks/guard.py` behavior
  described in section 4.
