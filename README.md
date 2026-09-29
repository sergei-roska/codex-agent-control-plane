# Codex Universal A2A Orchestrator

This project runs the eight development-team roles adapted from `codex-universal` as independent Agent2Agent (A2A) agents. A read-only lead plans and dispatches bounded work to those agents over A2A. Every role runs in its own Codex App Server thread under the local Codex ChatGPT sign-in.

```text
A2A client -> /orchestrator (lead)
                  | A2A dispatch
                  +-> /agents/orch-explorer -> Codex App Server thread
                  +-> /agents/orch-builder  -> Codex App Server thread
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

The lead Agent Card is at `http://127.0.0.1:3000/orchestrator/agent-card.json`. Each specialist has a card at `http://127.0.0.1:3000/agents/<role>/agent-card.json`; for example, `/agents/orch-explorer/agent-card.json`. A2A clients can discover these cards without credentials. Requests to the JSON-RPC endpoints require `Authorization: Bearer <token>`. The server creates the token at `.runtime/a2a-token` with owner-only access, and `npm run ask` reads it automatically. Keep that file private. For a custom client, read the token locally and send it as the bearer value. Set `CODEX_A2A_TOKEN_FILE` to use a different token path.

## Roles

| Agent | Workspace access |
| --- | --- |
| `orch-explorer` | Read-only |
| `orch-builder` | Workspace write |
| `orch-verifier` | Workspace write |
| `orch-auditor` | Read-only |
| `orch-repair-xhigh` | Workspace write |
| `orch-repair-sol` | Workspace write |
| `orch-architect` | Read-only |
| `orch-scout` | Read-only |

The lead uses GPT-6 Sol at high effort in a read-only Codex thread. Specialist model and effort settings are read from the bundled TOML profiles and can be changed for the signed-in Codex account.

## Safety and current limits

- Codex approval requests are declined by the local App Server client. A task that needs an additional permission must report that need; this service does not grant it silently.
- A2A task stores are in memory. Restarting the server loses A2A task status, although Codex may retain its own thread history.
- The lead validates assigned file paths and passes allowed files to workers. The Codex workspace sandbox restricts writes to the workspace, but the per-file assignment is enforced by worker instructions, not by a separate filesystem boundary. Use a trusted local workspace.
- A local bearer token protects the A2A JSON-RPC endpoints, and the server binds only to loopback. Agent Cards remain public for A2A discovery. Codex App Server is currently documented as experimental and unsupported for production workloads.

The proposed LangGraph migration for durable runs, usage-limit pauses, and rare human decisions is in [resilient-orchestration.md](docs/resilient-orchestration.md). It is a design, not a feature of the current runtime.

Run `npm test` for the protocol and orchestration tests. The HTTP integration test skips when the environment forbids binding a local port.
