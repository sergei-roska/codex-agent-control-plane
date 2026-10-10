# Session-continuous lead thread (SES-01)

Implemented in `63080b4`. Rollover measures the last model request's context
(`tokenUsage.last.inputTokens`) against 60% of `modelContextWindow`, not the summed
input of a turn, which overstated the context several times over.

Status: decided by the lead on 2026-10-10 at the owner's request: "Until I press New
session, every message is a continuation; the context, the cached tokens, and the
thread are kept. It is not a new task, it is a continuation."

## Today

- Every dashboard message in a session creates a new lead task (run) that references
  the previous one; `composeFollowUpGoal` passes only text (earlier goal, earlier
  result, and the LL-3 digest).
- Since LAT-01 (`fb7eac1`) the lead starts a fresh Codex thread every round (only a
  rejection retry resumes), because each round's self-contained prompt was appended to
  the thread again and the context grew to 196k tokens. Codex keys prompt caching by
  thread, so nothing is cached across rounds or messages.

## Decisions

1. One lead thread per session (A2A contextId). A durable table
   `session_threads(context_id TEXT PRIMARY KEY, thread_id TEXT, codex_home TEXT,
   last_input_tokens INTEGER, rollovers INTEGER NOT NULL DEFAULT 0, created_at TEXT,
   updated_at TEXT)`. Every lead turn of every run in the session resumes that thread
   when its `codex_home` equals the App Server's current home; otherwise a new thread
   is started and recorded. "New session" means a new contextId and a new thread.
2. Delta prompts. The first turn in a thread gets today's full decision prompt. Later
   turns in the same thread get only what is new since the lead's previous turn in
   that thread: the owner's new message (for a follow-up run), the run header (rounds
   used and limit, extensions), notes, rejection feedback, acceptance notes, human
   answers, outcomes finished since the lead's last turn (same bounding as today),
   the current open decisions, skill candidates when the goal changed, and a one-line
   reminder that the rules and roles from the start of the thread still apply and the
   answer must be JSON for the schema. The state records which outcomes the lead has
   already seen in this thread.
3. Rollover. If the previous lead turn's input tokens exceed
   `CODEX_A2A_LEAD_ROLLOVER_TOKENS` (default 150000), or the thread cannot be resumed
   (rejected resume, different Codex home after an account switch), the next turn
   starts a new thread with the full prompt plus a session digest (the LL-3 digest of
   the current run and the final texts of the session's earlier runs). The table counts
   rollovers.
4. A rejection retry keeps using the same thread, as today.
5. Workers are unchanged: a fresh thread per assignment; BUD-2 and LL-5 continuations.
6. Follow-up runs still get a goal from `composeFollowUpGoal` (it feeds skill matching
   and the run digest), but in a continuing thread the delta prompt shows only the
   owner's new message and points to the conversation for the rest.

## Not in scope

- Turning a session into a single A2A task: the dashboard keeps one task per message.
- Codex automatic compaction: rollover is explicit and under the orchestrator's
  control.
