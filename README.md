# Codex Universal A2A Orchestrator

This project runs the eight development-team roles adapted from `codex-universal` as independent Agent2Agent (A2A) agents. A read-only lead plans and dispatches bounded work to those agents over A2A. Every role runs in its own Codex App Server thread under the local Codex ChatGPT sign-in.

```text
A2A client -> /orchestrator (lead)
                  | A2A dispatch
                  +-> /agents/explorer -> Codex App Server thread
                  +-> /agents/engineer  -> Codex App Server thread
                  +-> /agents/...           -> Codex App Server thread
```

The role profiles, team rules, and skills are bundled in [`profiles/`](profiles/) so this project does not depend on the original pack path. The profiles were adapted to act as A2A workers while keeping their model choices and task boundaries. The lead uses structured decisions, checks role names and file paths, runs read-only assignments in parallel, and runs batches containing a writer serially. Repair roles follow the pack's escalation order.

## Requirements

- Node.js with `npm`.
- A local Codex CLI with `codex app-server` support.
- A Codex sign-in through ChatGPT OAuth. Check with `codex login status`; it should say `Logged in using ChatGPT`.

The server checks App Server's active account on startup and rejects API-key mode. It binds only to `127.0.0.1` and does not need `OPENAI_API_KEY`.

## Run

```bash
npm ci
npm start
```

In another terminal:

```bash
npm run ask -- "Inspect this repository and propose the next implementation step"
```

The default target workspace is the current directory. Set `CODEX_WORKSPACE=/absolute/path/to/project` to work on another local project and `PORT=3000` to choose the A2A listener port. Start the server from this project directory so it can load `profiles/`.

Codex App Server RPC requests time out after 120 seconds. Model turns have a separate 60-minute completion timeout; set `CODEX_A2A_TURN_TIMEOUT_MS` to a positive integer number of milliseconds to change it.

The lead Agent Card is at `http://127.0.0.1:3000/orchestrator/agent-card.json`. Each specialist has a card at `http://127.0.0.1:3000/agents/<role>/agent-card.json`; for example, `/agents/explorer/agent-card.json`. A2A clients can discover these cards without credentials. Requests to the JSON-RPC endpoints require `Authorization: Bearer <token>`. The server creates the token at `.runtime/a2a-token` with owner-only access, and `npm run ask` reads it automatically. Keep that file private. For a custom client, read the token locally and send it as the bearer value. Set `CODEX_A2A_TOKEN_FILE` to use a different token path.

## Roles

| Machine ID | Interface name | Workspace access |
| --- | --- | --- |
| `coordinator` | Team Coordinator | Read-only |
| `explorer` | Code Explorer | Read-only |
| `engineer` | Software Engineer | Workspace write |
| `verifier` | Quality Engineer | Workspace write |
| `auditor` | Code Auditor | Read-only |
| `recovery-engineer` | Recovery Engineer | Workspace write |
| `senior-engineer` | Senior Engineer | Workspace write |
| `architect` | Systems Architect | Read-only |
| `scout` | Quick Scout | Read-only |

The lead uses GPT-6.1 Sol at high effort in a read-only Codex thread. Specialist model and effort settings are read from the bundled TOML profiles and can be changed for the signed-in Codex account.

The interface shows human role names with machine IDs as secondary labels. New profiles and endpoints use the IDs above. Legacy `orch-*` role endpoints and stored assignments remain compatible through aliases; task storage namespaces are retained so existing sessions can resume.

## Role tool surface

Every role gets a fixed tool surface declared in its profile; everything not declared is off. Each thread is started (and resumed) with config overrides that disable Codex apps and plugins, the Codex skills listing, and every user or project MCP server not on the role's allowlist. This cuts roughly 70k input tokens per turn of inherited tool schemas and skill text, and a stable per-role surface keeps prompt caching effective. The lead model does not choose tools.

To allow an MCP server or skills for a role, add a table at the end of its `profiles/agents/<role>.toml`:

```toml
[a2a_tools]
mcp_servers = ["some-server"]  # names as in [mcp_servers.*] of your Codex config
skills = false                 # true keeps the Codex skills listing
```

A missing table means no MCP servers and no automatic skills listing. The pack's own `orch-*` skills are read as files by path and do not need the listing. An allowlisted name that is not configured is ignored and reported in `permissionConfig.toolPolicy.mcpMissing`. If the configured servers cannot be enumerated, the turn still runs and the policy is marked `enforced: false` (a cost problem, not a safety boundary). Sandbox and approvals are unaffected.

## Skills for each assignment

The imported skill library lives in [`profiles/skills/library/`](profiles/skills/library/). It contains the remaining skills copied from `ws-knowledge/skills`, including their references, scripts, and evaluation files. The library includes computer science patterns and the retained project and tooling workflows.

The lead receives the library's compact skill IDs and up to 12 relevant descriptions. It selects zero to five skills for each assignment through the `skills` field. Workers receive only those selected skills as explicit App Server skill inputs; the global skills listing stays disabled. Instruction hashes are pinned in the dispatch checkpoint and included in result provenance. Unknown IDs, duplicates, excessive selections, and instruction drift are rejected.

Skill instructions remain subordinate to the task, project and role rules, permissions, allowed files, and worker report contract. Importing a skill does not connect its MCP dependencies or authorize new agents, git changes, or broader filesystem access. See [skill-routing.md](docs/skill-routing.md) for the selection and versioning behavior.

## Writer admission

Every writable Codex turn passes through the role executor, which admits at most one writer per workspace (canonical path) using the state database.

- Waits: a second writer stays `SUBMITTED` (FIFO) while the holder is `active`; canceling while waiting ends `CANCELED` with no effects. Read-only roles never take admission and run alongside a writer.
- Blocks: while the holder is `unresolved` (its outcome is unknown), one reconciliation is attempted; if the process group cannot be proven gone, the new writer fails with `failureKind: "admission_blocked"` and no effects.
- Workspace lock: a second server on the same workspace is refused by a lock file in the OS temp dir (`codex-a2a-workspace-<hash>.lock`).
- Every writer records a before/after workspace snapshot (git); the server attests `changedPaths` (ignored files are invisible).

### Parallel writers in worktrees

When the workspace is the top of a git work tree without submodules, writers run in
parallel, each in its own git worktree ("lane"), and the server applies each lane's
patch to the shared working tree under writer admission when the writer finishes. The
lead groups concurrent assignments with `wave`; writers of one wave must own disjoint
`allowedFiles`. At startup the server proves with a sandbox probe that a lane cannot
write the shared tree, its `.git`, or through linked environment directories; if the
probe fails, writers run one at a time as before. Patches outside `allowedFiles`,
conflicts with concurrent edits, and canceled or failed turns are not integrated; the
lane is kept for inspection. See `docs/parallel-writers-design.md`.

- `CODEX_A2A_WRITER_ISOLATION=worktree|shared` (default `worktree`).
- `CODEX_A2A_LANE_LINKS` (default `.venv,venv,node_modules`): ignored directories linked into lanes.
- `CODEX_A2A_LANE_RETENTION_HOURS` (default 72): kept lanes are removed after this at startup.
- Lanes live under the state directory (`.runtime/projects/<id>/lanes`), or under `~/.cache/codex-a2a/lanes/` when that would be inside the workspace.

### Automatic resume after a usage limit

A run paused for Codex usage budget resumes by itself once the account may be used
again (`account/rateLimits/read`: `ordinaryUsageAllowed` and no reached limit for the
team's models). Checks run at the reported reset plus a minute and every 5 minutes;
sending a message still resumes at once. `CODEX_A2A_AUTO_RESUME=0` turns it off.

### Reconciliation pause

After a batch, the lead graph settles every writable outcome that is not provably finished, without asking a model. If quiescence cannot be proven, the lead task is `INPUT_REQUIRED` with pause `writer_unresolved`. Send any message to the task to retry once the earlier writer is stopped. Writable dispatch is refused while a writer is unresolved, and in a serial batch the remaining writers are skipped (`skipped_unresolved_writer`) after an unsettled one.

### Long runs and repeated work

Dispatch rounds have no default limit. Healthy implementation and research can
continue across short or long rounds; the counter is retained for reporting.
Callers may explicitly set a positive `maxRounds` when constructing the
orchestrator to impose their own cap. Progress does not extend an explicit cap;
owner `continue` or `change_goal` grants another configured allowance.

A bounded, checkpointed loop detector warns the lead after three equivalent
outcomes with unchanged relevant evidence. Another unchanged recurrence pauses
the run with `loop_detected` and evidence of the repeated work. The lead gets
the warning in its ordinary turn, without an extra model call. Owner `continue`
or `change_goal` starts a new detection episode; restart and usage-limit resume
retain the history. `accept_as_is` still runs all acceptance and review gates.

The detector is a heuristic over available evidence, not a guarantee that every
semantic loop is recognized. Per-invocation graph step limits resume from an
advanced checkpoint instead of exhausting the run's dispatch allowance. See
[LL-8](docs/lead-loop-fixes-design.md#ll-8-healthy-long-runs-and-repeated-work-recovery-2026-10-12).

## Acceptance

Finishing a workflow is not acceptance. When the lead decides to finish, the server computes a disposition in code; the lead's final text never changes it.

```bash
npm run ask -- --check 'npm test' --check 'node --check src/server.js' "Implement the change"
```

`--check` is repeatable, split on whitespace into argv (no shell), and valid for a new run only. The checks are pinned when the run starts (resume messages cannot change them), run under writer admission in the workspace, and must leave the workspace snapshot unchanged. Dispositions:

| Disposition | Meaning |
| --- | --- |
| `accepted` | Every check passed and no writer issue (invalid report, scope violation, unknown delta, unresolved writer). |
| `rejected` | Checks exist and any condition failed. The lead gets one chance to dispatch fixes; the second rejection ends the run. |
| `unverifiable` | Checks exist but no snapshot of the candidate is available. |
| `unverified` | No checks, at least one writer ran. |
| `not_required` | No checks and no writer ran. |

The task stays `COMPLETED`; the result text starts with `Acceptance: <disposition>` and the artifact metadata carries `acceptance`. The CLI exits 4 for `rejected` and `unverifiable`. Direct A2A clients may send `metadata.acceptance = { requiredChecks: [{ id, argv, timeoutMs? }] }` on the first message.

## Usage

Material routine changes are independently checked by `verifier` after
integration. `auditor` is selected for a recorded critical change, performance
requirement, completed component, bounded investigation, or owner request.
Changed pinned acceptance scripts retain their separate read-only integrity
review. A round ending alone does not trigger either review. Declared review
checkpoints bind their evidence to scoped content, including uncommitted files;
model risk classification remains a lead responsibility.

Acceptance audit reports use an exact standalone first summary line, such as
`VERDICT: pass`. `checks` records required executions or explicit validation
of cited prior evidence. Supplemental diagnostics, excluded tests and reused
verifier evidence go in `risks` with their result and limitation; reused tests
are never described as fresh runs. Failed or unrun assigned checks still
prevent a passing receipt. See the
[report contract](docs/auditor-routing-contract.md).

After the launcher confirms an owner Pause or Stop and running workers have
finished, **New session** opens a fresh context. The old session remains in
the session list and can be resumed. A pending pause or message keeps the
button disabled.

Staging problems, attempted remedies, review results, and explicit architectural
decisions are retained in an append-only state-database log. Read its bounded
history without starting the server:

```bash
npm run staging:report -- --state <project-state.sqlite> --run <runId> --json
```

The report distinguishes unavailable, partial, and complete history. ADRs and
qualified production actions are indexed in `docs/production-transfer.md`.

Every Codex turn (worker and lead) is recorded in the state database with model, effort, elapsed time, and tokens where known (unknown stays empty, never 0). Cost is not measured: it is subscription usage.

```bash
npm run usage -- --run <taskId>      # or --task <taskId>; optional --state <file> --price-table <json>
```

The report groups usage by run, role, and attempt, counts permission denials, and reports repeated assignment objectives. A price table adds a separately labeled hypothetical API cost.

The design is in [hardening-spec.md](docs/hardening-spec.md); [efficiency-comparison.md](docs/efficiency-comparison.md) describes how to compare against native subagents.

## Safety and current limits

- The client pins `approvalsReviewer: "user"` on thread/start, thread/resume, and turn/start, overriding any `auto_review` in the user's Codex config, so every approval request reaches the local App Server client, which declines it. A task that needs an additional permission must report that need; this service does not grant it silently.
- Runs are durable. LangGraph checkpoints, A2A tasks, and the dispatch journal live in `.runtime/state.sqlite` (override with `CODEX_A2A_STATE_DB`), and only one server may use a state file at a time. After a crash, the lead task shows `INPUT_REQUIRED` (pause `restart`). Worker tasks that were running show `FAILED` (`interrupted`). On startup the server reconciles the interrupted writer mechanically (see Writer admission), so the lead sees attested effects instead of inspecting the workspace itself.
- If the Codex App Server child exits or times out, the next request starts a replacement process. An interrupted writer may have changed files, so its outcome is unknown until the server proves the writer stopped (reconciliation); no new writer runs before that.
- Pauses: a usage limit (`waiting_for_budget`), a rare human decision (`human_decision`), a restart, or a resumable error leaves the lead task `INPUT_REQUIRED` with `metadata.pause`. Continue with `npm run ask -- --task <taskId> [--decision <id>] [--choice <optionId>] "<answer>"`. The CLI exits with code 3 while a task is paused and 4 when acceptance is `rejected` or `unverifiable`.
- The lead validates assigned file paths and passes allowed files to workers. The Codex workspace sandbox restricts writes to the workspace, but the per-file assignment is enforced by worker instructions, not by a separate filesystem boundary. Use a trusted local workspace.
- A local bearer token protects the A2A JSON-RPC endpoints, and the server binds only to loopback. Agent Cards remain public for A2A discovery. Codex App Server is currently documented as experimental and unsupported for production workloads.

The durable-run design is in [resilient-orchestration.md](docs/resilient-orchestration.md). The implemented decisions and known limits are in [resilient-orchestration-spec.md](docs/resilient-orchestration-spec.md).

Run `npm test` for the protocol, orchestration, durability, and end-to-end tests. They use a fake App Server and never call Codex. The HTTP integration test skips when the environment forbids binding a local port.
