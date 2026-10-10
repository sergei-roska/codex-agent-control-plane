# Dashboard ideas backlog

Status: ideas recorded at the owner's request on 2026-10-10. Not designed, not
scheduled. Each item needs a short design before implementation.

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
