# Multi-project launcher and long sessions

Branch: `feature/multi-project-sessions`. Owner: dev lead. Workers: worker-sonnet, one step at a time per file.

## Problem

1. The launcher runs one orchestrator on a hard-coded port 3000 with one `CODEX_WORKSPACE` and one state DB
   (`.runtime/state.sqlite`). Two browser tabs show the same server, so two projects cannot work in parallel.
   `freePort3000()` SIGKILLs whatever listens on 3000, including another orchestrator.
2. Every message in the UI is a new task ("session"). The user wants one session per unit of work: a conversation
   with follow-up messages, and a "New session" button to start over.

## Established facts (verified in code)

- `src/server.js` already takes `PORT`, `CODEX_WORKSPACE`, `CODEX_A2A_STATE_DB`; `acquireStateLock` and
  `acquireWorkspaceLock` stop two orchestrators from sharing a DB or a workspace.
- `loadOrCreateAuthToken` creates the token file with O_EXCL; a concurrent reader can see an empty file.
- Follow-ups exist: `referenceTaskIds` -> `composeFollowUpGoal` (src/server.js) builds a new run whose goal embeds the
  earlier goal and result (nested, capped at 24000 chars, oldest text dropped first).
- `/api/task/send` already reuses the previous task's `contextId` for `taskId`/`continueFrom`, so a chain of follow-ups
  shares one A2A `contextId`. `tasks.context_id` is a column of the SDK task store.
- `launcher.js` is 2200+ lines; the UI is one template literal (client code needs `\\n` escapes).

## Decisions

- D1 Project = registered workspace. One orchestrator process per project, own port (3000-3099, persisted), own state DB.
- D2 Registry file `.runtime/projects.json` (atomic write). Project id = first 10 hex of sha1(realpath).
- D3 State DB per project: `.runtime/projects/<id>/state.sqlite`. Exception: while the registry is empty, the first added
  project adopts the legacy `.runtime/state.sqlite` (no data move).
- D4 A tab is bound to a project through `?project=<id>`. Two tabs, two projects.
- D5 No port-based killing. Stop signals only the child the launcher spawned, or a registry pid that still listens on the
  project's own port. An orchestrator with no known pid is reported as "not managed", never killed.
- D6 Launcher ensures the token file exists (calls `loadOrCreateAuthToken`) before spawning any orchestrator.
- D7 Session = A2A `contextId`. No new backend persistence. A follow-up is `continueFrom = last terminal turn`.
  Rejected alternative: one long-lived lead run. A2A tasks are immutable once terminal and the acceptance contract is
  pinned per run, so that would rework the hardened state machine.
- D8 The UI moves out of the template literal into `launcher-ui/` (index.html, styles.css, app.js) before any feature work.

## Steps

| Step | Scope | Done when |
|---|---|---|
| S1 | Extract UI to `launcher-ui/`, zero behavior change | Served page, CSS and JS are byte-equivalent to the old inline output |
| S2a | `src/launcher-projects.js` project manager + unit tests (new files only; parallel with S1) | `node --test test/launcher-projects.test.js` green |
| S2b | Wire the manager into the launcher: `/api/projects/...` routes, per-project task reads, project bar in the UI, tab binding, remove `freePort3000` | Two tabs run two projects at once (manual check with two scratch workspaces) |
| S3 | Sessions: `/api/projects/:id/sessions...`, transcript view, Send = follow-up, New session button, history lists sessions | A follow-up message lands in the same session; history shows one row per session |

Each step ends with: lead reads the diff, runs the checks, commits on the branch.

## Known limits

- Follow-up context is capped at 24000 chars; in a very long session the oldest turns are dropped silently.
- Each follow-up is a fresh lead run (re-plans, re-reads the repo); only the earlier goals and results carry over.
- Only one launcher instance is supported.
- Nested workspaces (project inside another project) are not detected.
