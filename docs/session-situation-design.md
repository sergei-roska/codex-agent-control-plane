# Session situation view

Status: SIT-1..SIT-3 in progress (2026-10-11); SIT-4 awaiting owner decision.

## Problem

The owner keeps asking the lead "where are we, what is the plan, what
changed" and has to wait for the turn to finish, or opens Codex in the project
to ask. The dashboard holds most of this data but does not show it.

## What exists (research 2026-10-11)

- A2A task state in `tasks.status_state`; lead graph nodes intake, decide,
  dispatch, collect, verify, reconcile, human_input, budget_pause,
  continue_limited, accept, review_check, finish (`src/lead-graph.js` ~2056).
- Lead run state (current batch with role/state/assignmentId,
  pendingAssignments, openDecisions, progress[], budget, acceptance) lives in
  the LangGraph checkpoint (`checkpoints` table, LeadState ~575-611). The
  launcher does not read it.
- `live_activity` (worker and `lead:<runId>` rows) is already shown.
- Changed files: worker `report.filesChanged` in checkpoint outcomes;
  `writer_executions.delta_json.changedPaths` for finished writers. No git
  status endpoint.
- The composer is locked while the lead works; the server rejects a second
  message to a running task. Notes to a running lead (`pendingNotes`) are
  in-memory only.
- No structured next-steps field; `lead-orchestrator.js` ~90 scans final text
  for a "Next work" section.

## Tasks

### SIT-1 situation endpoint (backend, read-only)

    GET /api/projects/:id/sessions/:contextId/situation
    200 {
      "contextId", "leadTaskId",            // latest lead turn of the session
      "state": "<A2A state>", "node": "<graph node>|null",
      "phase": "planning|working|verifying|waiting_owner|budget_pause|done|failed|canceled",
      "round": n|null, "budget": { ...known fields as stored }|null,
      "startedAt", "updatedAt",
      "batch": [{ "assignmentId", "role", "objective", "state": "pending|running|done|failed",
                  "summary": str|null, "filesChanged": [str], "startedAt", "finishedAt" }],
      "openDecisions": [{ "id", "summary" }],
      "progress": [{ "at", "text" }],      // last 10
      "acceptance": { "status", "checks": [{ "name", "status" }] }|null,
      "nextSteps": str|null                // from the final result when done
    }
    404 when the session does not exist.

Phase mapping: intake/decide -> planning; dispatch/collect -> working;
verify/review_check/reconcile/accept -> verifying; human_input or
INPUT_REQUIRED -> waiting_owner; budget_pause -> budget_pause; terminal A2A
states -> done/failed/canceled. Fields that cannot be derived are null or [],
never invented.

### SIT-2 project git status (backend, read-only)

    GET /api/projects/:id/git-status
    200 { "available": true, "branch", "head", "files": [{ "path", "status" }],
          "diffstat": { "files", "insertions", "deletions" } }
    200 { "available": false } when the project is not a git repo.

`git status --porcelain=v1` and `git diff --shortstat HEAD` with a timeout,
argv form, no shell.

### SIT-3 situation panel (UI)

Pinned at the top of the session column, above the chat:
- phase stepper (Planning, Working, Verifying, Done) with side states
  "Waiting for you" (accent) and "Budget pause";
- round and budget line;
- "Now": running assignments (role, objective, elapsed);
- "Done this turn": finished assignments with one-line summary and files;
- "Changed files": git-status list with diffstat, uncommitted count;
- for a finished session: "Where we stopped" with nextSteps.
Collapsible, remembers its state per viewer. Polls with the existing status
loop (no new tight loop).

### SIT-5 ask the scout (owner decision 2026-10-11)

The owner asks questions at any time, including while the lead works, and the
existing `scout` role (gpt-6-luna, medium, read-only) answers. It does not
interrupt or message the lead. The scout roams the project read-only to gather
context for the owner; the SIT-1 situation and SIT-2 git status are given to it
as a starting pack. Answers cite their sources (file:line, task ids).

Dispatch path (research 2026-10-11): the lead reaches roles over A2A at
`${baseUrl}/agents/<role>`; a plain-text SendMessage with a fresh contextId
already runs one read-only role without a run, assignment, worktree, writer
admission or dispatch_journal (`a2a-role-service.js` ~303-620). The per-role
read-only sandbox and MCP policy are applied inside `CodexAppServer.run`, so a
standalone scout gets the same guard. No worker pool cap exists; the shared
resources are the single app-server child (restart budget 3) and the accounts.

Decisions:
- Entry point is the launcher, not the lead's server: `POST
  /api/projects/:id/ask { question, sessionContextId? }` sends one plain-text
  message to `/agents/scout` with a fresh contextId and the loopback token,
  returns `{ askId }`; `GET /api/projects/:id/ask/:askId` returns
  `{ state, answer, startedAt, finishedAt, error }`. `DELETE` cancels.
- Guards: one scout run at a time per project (409 otherwise); hard timeout
  5 minutes, then cancel; project server must be running (409 otherwise).
- Prompt: the owner's question, then a bounded data pack (SIT-1 situation +
  SIT-2 git status of the open session, capped at ~8 KB, marked as data).
- Scout profile gets an owner-question mode: when the message is an owner
  question, answer it from read-only exploration with file:line / task-id
  citations instead of an inventory; the existing worker report schema stays
  (answer in its summary/details fields).
- UI: while the lead works the composer no longer locks; it switches to
  "Ask scout" mode (and an explicit toggle is available any time). Answers
  render as a distinct scout bubble in the session view, not sent to the lead.
- Usage: scout rows are recorded (role scout, runId null) but are not in the
  session team band yet; showing them is a follow-up.
- Risk area (shared app-server child, accounts, auth): Sonnet worker, Opus
  critic. Starts after SIT-1 lands (it consumes the situation pack).

### SIT-4 owner notes to a running lead (needs owner decision)

Let the owner queue a note while the lead works; the lead consumes it at the
next decide node. Requires making `pendingNotes` durable and a new message
path; touches the lead loop (risk area). Not started.
