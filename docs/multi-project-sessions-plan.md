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
- D9 A new session gets its id from the UI (`crypto.randomUUID()`), sent as `contextId` on the first message. The SDK
  honors a client-provided id (`incomingMessage.contextId || task?.contextId || randomUUID()`), so the transcript can
  poll the session before the first run finishes. The launcher accepts `contextId` only when neither `taskId` nor
  `continueFrom` is given.
- D10 Any session can be reopened and continued from its last terminal turn; there is no read-only archive mode. The
  server's existing one-active-lead-task rule (`rejectOverlappingLeadTask`) stays the guard against overlapping runs.

## Steps

| Step | Scope | Done when |
|---|---|---|
| S1 | Extract UI to `launcher-ui/`, zero behavior change | Served page, CSS and JS are byte-equivalent to the old inline output |
| S2a | `src/launcher-projects.js` project manager + unit tests (new files only; parallel with S1) | `node --test test/launcher-projects.test.js` green |
| S2b | Wire the manager into the launcher: `/api/projects/...` routes, per-project task reads, project bar in the UI, tab binding, remove `freePort3000` | Two tabs run two projects at once (manual check with two scratch workspaces) |
| S3 | Sessions: `/api/projects/:id/sessions...`, transcript view, Send = follow-up, New session button, history lists sessions | A follow-up message lands in the same session; history shows one row per session |

Each step ends with: lead reads the diff, runs the checks, commits on the branch.

## S3 spec (sessions)

Backend (`src/launcher-app.js`):
- `GET /api/projects/:id/sessions` -> `{ sessions: [{ contextId, goal, turns, state, updatedAt, lastTaskId, disposition }] }`,
  newest first. Group lead tasks (`owner = 'orchestrator'`) by `context_id`; a row with an empty `context_id` is its own
  session keyed by its task id. `goal` is the first user text of the earliest turn; `state`, `updatedAt`, `disposition`
  and `lastTaskId` come from the last turn.
- `GET /api/projects/:id/sessions/:contextId` -> `{ contextId, turns: [{ leadTask, workers }] }`, oldest first (order by
  `status_last_updated`), 404 when empty. `leadTask` has the shape used today.
- `DELETE /api/projects/:id/sessions/:contextId`: one transaction, shared `deleteLeadTask(db, taskId)` helper with the
  single-task delete; 400 if any turn is not terminal; 404 if none.
- `POST /api/projects/:id/task/send` accepts an optional `contextId` (UUID pattern), used only for a new session (D9).
- `tasks/latest` and `tasks/history` are replaced by the session routes.

UI:
- The single result area becomes a transcript: per turn a user bubble (that turn's own request) and the lead's answer
  (working: progress and round specialists; paused: decision card under the transcript; completed: result text and
  acceptance badge; failed: error text). Stay scrolled to the bottom only when the user already was.
- Composer: one textarea (placeholder says "Describe the goal" when no session is open, "Reply in this session" when
  one is), checks field unchanged, primary button "Send" (Ctrl+Enter). Open session with a terminal last turn: send with
  `continueFrom = last turn id` and the session's `contextId`. No session open: create a UUID, send as `contextId`. Last
  turn working or paused: composer disabled with a hint (paused is answered through the decision card).
- "New session" button: enabled when a session is open and its last turn is terminal; clears the open session and
  focuses the composer; deletes nothing.
- The old Continue and Close buttons, the archive banner and the dismissed/archived view state are removed.
- History modal lists sessions (goal, turn count, state, time); Open opens the session; Delete removes the whole session
  (confirm, terminal only).
- Tab binding: `?project=<id>&session=<contextId>`. On load without `session`, open the project's latest session if any.
  Switching project clears the session. Poll the open session every second; list sessions on load and after sends.

## Known limits

- Follow-up context is capped at 24000 chars; in a very long session the oldest turns are dropped silently.
- Each follow-up is a fresh lead run (re-plans, re-reads the repo); only the earlier goals and results carry over.
- Only one launcher instance is supported.
- Nested workspaces (project inside another project) are not detected.
