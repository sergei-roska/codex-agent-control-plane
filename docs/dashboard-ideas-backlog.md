# Dashboard ideas backlog

> Archived development plan, 2026-11-06. Use the [current autonomous delivery backlog](autonomous-delivery-backlog.md) for new work. The historical content below preserves decisions, IDs and evidence; its priorities and restrictions do not override the current owner requirements.

Status: ideas recorded at the owner's request on 2026-10-10. Not designed, not
scheduled. Each item needs a short design before implementation.

## UI-PERF-01: performance and token charts

Status: implemented in the working tree on 2026-10-14; independent review
approved. Full project checks: 1092 passed, 1 optional live probe skipped,
0 failed. Live desktop/mobile layout and static-snapshot data were verified.

Final owner scope: keep the visible page compact. Link it from the console with
the selected project/session; show task tokens and recorded working time in two
compact charts with a short summary. Keep the paginated detail table collapsed
by default. Use readable body/control/table text of at least 16 px and labels
of at least 14 px; keep the existing page style.

Keep richer optimization statistics in a separate local SQLite metrics table for
agent analysis: session/run/task attribution, model and effort, numerical token
and timing data, retries, permission denials, execution outcomes, reported review
verdicts, checks, and receipt status. Collect from the orchestrator state database
through a read-only connection; never migrate or write that source database.
Collection is deterministic and requires no additional LLM calls. Publish only
a compact numerical snapshot for the visible page.

The page reads persisted evidence and preserves ReAct, writer/review admission,
budget gates, model choices, and reasoning effort. It must work on the already
loaded launcher through the existing static/usage/session routes. New detailed API telemetry
is optional until a safe launcher transition; restarting the active launcher
would stop the running project servers and is excluded.

Missing measurements remain unknown. Label legacy dispatch lifecycle spans
separately from measured execution durations; overlapping durations are not
end-to-end wall time. Distinguish completed execution, a passing review receipt,
and accepted project checkpoints. Reasoning output is already included in output
tokens. Token counts are not a monetary bill. Compare matching tasks and include
failed work before claiming an efficiency improvement.

Further diagnostic candidates: repeated reads/tool calls, rework per accepted
result, scheduling/admission refusals, cache-prefix stability, and per-request
latency. These require adequate telemetry before adding graphs or changing
behavior. Token prompt compression itself remains queued as TOK-PROMPT-01 in
`orchestrator-improvement-backlog.md`.

## UI-01: skills and MCP tools of the current run

Under the session status line ("Status: task in progress..."), show what the
agents of the current run were given:

- Skills: the names of the skills selected for each assignment (the lead picks 0-5
  per assignment; they are pinned per attempt as `skillPins` in the dispatch batch and
  sent to the specialist), grouped by role or assignment, with the active ones
  highlighted.
- MCP servers: the servers enabled for each running turn and their tools, as
  "server: tool, tool". Today every role profile has an empty
  `a2a_tools.mcp_servers`, and `CodexAppServer._toolPolicy` disables every other
  server per thread, so the list is empty until a role is given servers (see
  UI-02). The App Server already exposes per-thread inventories
  (`mcpInventory`, `mcpServerStatus`).
- Open: where the session payload gets these (dispatch journal, specialist task
  metadata, or a new per-attempt record), and whether to show tool calls actually
  made (from live activity) or only what was available.

## UI-02: integrations sidebar

A right sidebar with connections to external services, starting with Confluence,
Figma, Google Tag Manager, and Context7; the owner will add more.

- Source of truth: the MCP servers in the Codex config (`config/read`), shown with
  connection and auth state, a Connect / Sign in action for OAuth servers, and a
  per-role toggle that decides which roles may use a server (today
  `a2a_tools.mcp_servers` in `profiles/agents/*.toml`, all empty).
- Accounts: with ACC-01 each Codex account has its own home; decide whether MCP
  credentials are per account or shared.
- Safety: writes to company Jira/Confluence must not leave test artifacts; default
  external servers to read-only tools for agents unless the owner enables writes
  for a role, and show which roles can write where.
- Open: whether enabling a server for a role changes the role profile (owner-owned
  configuration) or a separate per-run override; how the lead learns which tools
  exist so it can brief workers.
