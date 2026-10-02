# Codex Agent Control Plane

A local, single-operator dashboard over a Codex App Server delivery team. You
write a ticket (or import a Jira issue), a nine-role delivery team plans and
implements it in a task repository, and you review the candidate, accept it, and
commit it. Every role runs in its own Codex App Server thread under your local
Codex ChatGPT sign-in and talks to the lead over the Agent2Agent (A2A) protocol.

Beta scope:

- Local and loopback-only (the server binds `127.0.0.1`), one operator, one
  writer at a time, a trusted task repository.
- The app can commit and push a reviewed candidate branch. You open the pull
  request yourself; the app does not create one.
- Jira and Confluence access is read-only intake. Nothing is ever written back
  to Atlassian.
- This is a beta candidate, not a hosted multi-user service. Known limits are in
  the [release notes](docs/m9/release-notes.md).

## Requirements

Tested combination (not a support range): Node.js 24.21.0, npm 12.1.0, Codex CLI
0.160.0.

- Codex signed in with ChatGPT: `codex login status` must say
  `Logged in using ChatGPT`. Startup refuses any other Codex account type,
  including API-key sign-in.
- A separate Git task repository, outside this checkout and clean before you
  submit a ticket. The server refuses a workspace that overlaps the application
  directory (parent, child, or symlink alias).

## Install and start

```bash
npm ci
CODEX_WORKSPACE=/absolute/path/to/task-repo PORT=3000 npm start
```

Start from this project directory. The server prints the listen URL and a
`Dashboard pairing URL: ...` line. Open that URL in a browser on the same
machine; the one-time code creates a local session. If the session is lost or
the code is used up, run `npm run dashboard:pair` for a fresh URL (it reads the
local token and uses the same `PORT`). Use the printed host string
(`127.0.0.1`) as-is: `localhost` and `127.0.0.1` have separate cookies. Do not
share the URL or the token file.

Environment variables the server reads:

| Variable | Meaning and default |
| --- | --- |
| `CODEX_WORKSPACE` | Task repository. Default: current directory (accepted only if it does not overlap the application). |
| `PORT` | Listener port. Default `3000`. |
| `CODEX_A2A_STATE_DB` | SQLite state file. Default `.runtime/state.sqlite` in this checkout. One server per state file. |
| `CODEX_A2A_TOKEN_FILE` | Local bearer token. Default `.runtime/a2a-token` (created owner-only). |
| `CODEX_A2A_ARTIFACT_DIR` | Attachment bytes. Default `artifacts/` next to the state file. |
| `CODEX_PROJECT_CONFIG` | Project policy file. Default `project.json` next to the state file. |
| `CODEX_ATLASSIAN_CONFIG` | Absolute path to the Atlassian connector config. Optional; see below. |
| `CODEX_A2A_WORKSPACE_LOCK_DIR` | Directory for the per-workspace lock file. Default: the task repository's Git common directory (`.git/codex-a2a-writer.lockdb`); the OS temp dir only for a non-Git workspace. |
| `CODEX_A2A_TURN_TIMEOUT_MS` | Model turn timeout in ms. Default 10 minutes. |

Path rules checked at startup: the token, state database, artifact root,
workspace lock directory, project config, and Atlassian config must be outside
the task repository, and the Codex home/session storage must be too. The task
repository must be outside this checkout. A violation stops startup; move the
file rather than weakening the check. A second server on the same workspace or
state file is refused.

### project.json

Optional operator-owned policy, read once at startup (restart after editing).
Without it the defaults are base ref `main`, branch prefixes `feature/`, `fix/`,
`docs/`, remote `origin`, and no approved checks. Put it next to the state file
(default `.runtime/project.json`):

```json
{
  "baseRef": "main",
  "checks": [
    { "id": "unit", "argv": ["npm", "test"], "timeoutMs": 120000, "description": "Unit tests" }
  ]
}
```

Other fields: `branchPrefixes` (`feature`, `bugfix`, `docs`), `delivery.remotes`
(allowed push remotes), and `rolePack` (`delivery` or `legacy-orch`). Checks run
as argv (no shell) in the task repository. Unknown fields are rejected.

## Using the dashboard

Tabs:

- **Board**: tickets by state; create tickets and open a ticket's detail, run
  log, checks, and diff.
- **Pipelines**: runs and the ticket presets (feature, bugfix, docs, audit).
- **Monitor**: live event console with category and role filters.
- **Decisions & Escalations**: Intake questions, escalations, reviews, and the
  answered history.
- **Docs**: read-only viewer for the role-pack documents and the active project policy.
- **Connections & Models**: Codex account status, the Atlassian connector, and
  per-role model and effort settings.

Direct ticket:

1. **New Ticket**: enter a bounded request and acceptance criteria, attach only
   needed files, and save.
2. Check it on **Board** and Submit from Backlog. PM Intake and a saved plan come
   first; answer any Intake questions in **Decisions & Escalations**.
3. Review the run log, attempts, checks, and candidate diff. A failed or
   unavailable check is not a verified candidate. **Request corrections** with
   concrete findings if it needs rework.
4. **Accept** only the candidate you reviewed, then **Commit**, and optionally
   **Push**. Commit and push are separate operator actions bound to the reviewed
   candidate. The repository lease follows the ticket: normal order is review,
   Accept, Commit, optional Push, then the next ticket. A second ticket waits
   (`repository_busy`) until the lease clears. Do not touch the checkout while a
   run is active or awaiting review.

Jira ticket (optional): follow the [connector setup](docs/m6/operator-setup.md)
(dedicated Atlassian app, private secret files outside the task repository,
`CODEX_ATLASSIAN_CONFIG`), then use **Connect** in **Connections & Models** from
the same origin as the registered callback port. Import by issue key or numeric
ID, inspect the issue and Confluence provenance, then Submit. The lifecycle is
the same as a direct ticket. **Refresh Source** stages changed source content as
pending context for a new revision. Without the connector, direct tickets work
unchanged.

Models: set the model and effort per role in **Connections & Models**. Changes
apply to new runs; a running run keeps the settings pinned at its start.

Pause, Resume, Stop, Cancel, Return to Backlog, and Release Repository are
state-checked commands; see the [operator guide](docs/m9/operator-guide.md).

## Operating safely

- Pause active runs and wait for Paused (or review) before a planned stop. A clean
  stop (Ctrl+C or SIGTERM) cancels runs still executing; recover with Return to
  Backlog, then Submit. A crash leaves a run resumable (`interrupted`).
- Back up and restore only with the server stopped, keeping the database and the
  attachment directory together:
  [state upgrade, backup and restore](docs/operations/state-upgrade.md).
- Symptoms and fixes: the troubleshooting table in the
  [operator guide](docs/m9/operator-guide.md#troubleshooting).

## Trying it without model quota

```bash
npm test                                    # unit and integration tests, fake App Server
node scripts/role-capability-check.js --fake  # ten role cases through the real pipeline, fake models
npm run dashboard:dev                       # real server, fake Codex; state under .runtime/dev/
DASHBOARD_DEV_SCENARIO=delivery npm run dashboard:dev
```

`npm run roles:check` is the same script as `node scripts/role-capability-check.js`.
The dev harness listens on `PORT` (default 3000), so stop other servers on that
port first. In `delivery` mode the workspace is a small node project with a `unit`
check and a local bare `origin`; ticket title keywords change the scenario:
`[ask]` (Intake asks two questions), `[break]` (Developer breaks the test and the
repair role fixes it), `[bug]`, `[docs]`, `[audit]` (pick that preset). For a
fresh pairing URL against the harness:
`CODEX_A2A_TOKEN_FILE=.runtime/dev/a2a-token PORT=3000 npm run dashboard:pair`.

Live checks (`node scripts/role-capability-check.js --live` or `--live-workers`)
need `--i-understand-this-uses-my-quota` and spend your ChatGPT plan quota.

## A2A and CLI

The server also exposes the lead at `/orchestrator` and each role at
`/agents/<role>/` with public Agent Cards and bearer-protected JSON-RPC.
`npm run ask -- "<request>"` submits a run from a terminal (`--check '<cmd>'`
adds acceptance checks); `npm run usage -- --run <taskId>` reports per-run model
usage. Subscription usage is not priced; monetary cost is unavailable.

## More documentation

- [Operator guide](docs/m9/operator-guide.md): install, tickets, recovery, troubleshooting, limits
- [State upgrade, backup and restore](docs/operations/state-upgrade.md)
- [Atlassian connector setup](docs/m6/operator-setup.md)
- [Security review](docs/m9/security-review.md)
- [Release notes](docs/m9/release-notes.md) and [release checklist](docs/m9/release-checklist.md)
- [Beta master plan](docs/beta-master-plan.md)

## Protected reference

`artifacts/dashboard/**` is an immutable design reference and is never edited or
served; the app serves the working copy in `web/dashboard`.
