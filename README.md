# Codex Universal A2A Orchestrator

This project runs the eight development-team roles adapted from `codex-universal` as independent Agent2Agent (A2A) agents. A read-only lead plans and dispatches bounded work to those agents over A2A. Every role runs in its own Codex App Server thread under the local Codex ChatGPT sign-in.

```text
A2A client -> /orchestrator (lead)
                  | A2A dispatch
                  +-> /agents/explorer -> Codex App Server thread
                  +-> /agents/engineer  -> Codex App Server thread
                  +-> /agents/...           -> Codex App Server thread
```

The role profiles, team rules, and skills are bundled in [`profiles/`](profiles/) so this project does not depend on the original pack path. The profiles were adapted to act as A2A workers while keeping their model choices and task boundaries. The lead uses structured decisions, checks role names and file paths, and groups independent assignments into concurrent waves when worktree execution is available. Dependent steps and conflicting writes remain ordered. Repair roles follow the pack's escalation order.

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
| `verifier` | QA (Quality Assistance) | Workspace write |
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

## Execution permissions

Trusted projects inherit the active Codex account's configured permissions for
writable roles and agent-proposed final checks. Inspection roles remain
read-only. Set `executionPermissions: "strict"` in the project's settings to
retain the previous sandbox policy; unavailable or untrusted native configuration
also falls back to strict. See [execution-permissions.md](docs/execution-permissions.md)
for worktree behavior, existing-thread policy updates, and authorized shared
Git operations.

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

### Transient Lead recovery

Selected-model capacity and eligible service/transport failures can retry at the
same safe Lead decision checkpoint with bounded backoff. Automatic recovery
requires an unchanged checkpoint and no unresolved writers; quota, authentication,
configuration, and unknown errors remain on their existing budget or manual
paths. See [transient-recovery.md](docs/transient-recovery.md) for categories,
retry limits, pause controls, and restart behavior.

### Reconciliation pause

After a batch, the lead graph settles every writable outcome that is not provably finished, without asking a model. If quiescence cannot be proven, the lead task is `INPUT_REQUIRED` with pause `writer_unresolved`. Send any message to the task to retry once the earlier writer is stopped. Writable dispatch is refused while a writer is unresolved, and in a serial batch the remaining writers are skipped (`skipped_unresolved_writer`) after an unsettled one.

### Long runs and repeated work

A run has a default budget of 80 dispatch rounds (`DEFAULT_MAX_ROUNDS`, a
per-run cap). Reaching it does not fail the run: it pauses as `round_limit`
with a summary of where the rounds went (dispatches by role, integrated
changes). Owner `continue` grants another 80 rounds counted from the current round (a
legacy run already past the cap gets a full allowance), `change_goal` starts a
fresh allowance, and `accept_as_is` finishes with the current result. A caller
may pass another positive `maxRounds` to the orchestrator, or `null` for no
cap. Progress does not extend the cap automatically.

Two checkpointed detectors stop repeated work. Once a fully settled batch
confirms no progress, the run completes with an honest partial result and final
deterministic acceptance. It does not request owner continuation or dispatch
another repair or review. Failed and unavailable checks remain visible, and
unreviewed checkpoints cannot become accepted. Owner pauses, unresolved writers,
and usage-limit recovery retain their existing behavior and guard history.

- Evidence guard: the lead is warned after three equivalent outcomes with
  unchanged relevant evidence (the identity of the report's inspected files,
  checks and findings); another unchanged recurrence concludes the run. The lead
  gets the warning in its ordinary turn, without an extra model call.
- Recurrence guard: the key is (checkpoint id, role class, target content
  identity). The role class is `verify` (verifier), `audit` (auditor) or
  `investigate` (explorer, scout, architect); the target is the review target
  identity the run tracks, else the scoped content identity, else the
  objective. Without a checkpoint id the objective stands in for it, except
  for plain research (no checkpoint), which stays with the evidence guard.
  Report text and file lists are not part of the key, so a reviewer that words
  its findings differently each round still counts. When the same key recurs
  in three rounds, the run concludes with the rounds and the checkpoint listed.
  A changed target starts its own count; an unrelated integrated write does
  not erase history for the unchanged target. There is no warning step.

The detectors are heuristics over available evidence, not a guarantee that
every semantic loop is recognized. Per-invocation graph step limits resume from
an advanced checkpoint instead of exhausting the run's dispatch allowance. See
[LL-8](docs/lead-loop-fixes-design.md#ll-8-healthy-long-runs-and-repeated-work-recovery-2026-10-12)
and [LL-9](docs/lead-loop-fixes-design.md#ll-9-stopping-and-concluding-with-a-partial-result-2026-10-20).

### Partial result

The lead may finish with `goalAchieved: false` and a `checkpoints` ledger of
`{ id, status, reason, evidence }` entries, `status` being `accepted` (evidence
required), `blocked` or `not_started` (reason required), at least one of them
not accepted. That ends the run without an owner pause or an extra
investigation round: the task is `COMPLETED`, the result text starts with the
ledger, and the artifact metadata carries `disposition: "partial"` and
`checkpoints`. Acceptance still runs when checks are pinned and its result is
reported next to the ledger. A run whose acceptance is `rejected` or
`unverifiable` never reports a checkpoint as `accepted`; those entries are
downgraded to `blocked` with the reason (a lone pending review gate from a
blocked checkpoint does not downgrade the accepted ones). The ledger waives the
review gate only to admit the finish: blocked and not-started entries need no
receipts, and `not_started` is refused for a checkpoint with integrated writes.
Acceptance stays honest: unreviewed integrated writes still leave a
`review_gate_pending` issue, so the disposition is `unverifiable` and the CLI
exits 4, never an accepted partial.

When an `infeasible_requirement` or `credentials_or_access` request is answered
with the option id `defer` or `outside_run`, the review checkpoints it cites
(by checkpoint id or by an assignmentId in `evidenceChecked`) are recorded as
blocked: verifier, auditor and writer dispatch for them is refused (distinct
rejection codes) and they no longer hold unrelated writers or the finish
admission of a partial finish. Their unreviewed integrated writes still show in
acceptance. The ledger reports them as `blocked` with the owner's answer as the
reason.

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

The launcher composer has an optional "Acceptance checks" box (one command per line) that sends the same checks for a new run. Owner checks run on the host, unsandboxed. To set default owner checks once per project, add `ownerChecks` to the project settings file (`CODEX_A2A_PROJECT_SETTINGS`, read at server start, so restart the project to apply): `{ "version": 1, "ownerChecks": ["npm test"] }`. They apply to a new run that carries no explicit checks; explicit checks replace them. See [docs/execution-boundary-contract.md](docs/execution-boundary-contract.md).

The task stays `COMPLETED`; the result text starts with `Acceptance: <disposition>` and the artifact metadata carries `acceptance`. The CLI exits 4 for `rejected` and `unverifiable` and 5 for a partial result (see Partial result; exit 4 takes precedence when both apply). Direct A2A clients may send `metadata.acceptance = { requiredChecks: [{ id, argv, timeoutMs? }] }` on the first message.

## Background process cleanup

Completed role turns clean their managed background tool terminals before
writer settlement and lane integration. Cleanup is scoped to the thread;
other roles sharing the App Server continue. See
[background process lifecycle](docs/background-process-lifecycle.md) for
timeouts, failure handling and safe runtime application.

Launcher startup failures retain a bounded, sanitized diagnostic in each
project's runtime directory, so a launcher restart preserves the last failure.
Readiness requires the actual listener announcement or a successful status probe.

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
- Pauses: a usage limit (`waiting_for_budget`), a transient recovery wait, a rare human decision (`human_decision`), a restart, or a resumable error leaves the lead task `INPUT_REQUIRED` with `metadata.pause`. Continue with `npm run ask -- --task <taskId> [--decision <id>] [--choice <optionId>] "<answer>"`. The CLI exits with code 3 while a task is paused, 4 when acceptance is `rejected` or `unverifiable`, and 5 when the run finished with a partial result.
- The lead validates assigned file paths and passes allowed files to workers. The Codex workspace sandbox restricts writes to the workspace, but the per-file assignment is enforced by worker instructions, not by a separate filesystem boundary. Use a trusted local workspace.
- A local bearer token protects the A2A JSON-RPC endpoints, and the server binds only to loopback. Agent Cards remain public for A2A discovery. Codex App Server is currently documented as experimental and unsupported for production workloads.

The durable-run design is in [resilient-orchestration.md](docs/resilient-orchestration.md). The implemented decisions and known limits are in [resilient-orchestration-spec.md](docs/resilient-orchestration-spec.md).

Run `npm test` for the protocol, orchestration, durability, and end-to-end tests. They use a fake App Server and never call Codex. The HTTP integration test skips when the environment forbids binding a local port.
