# Per-assignment skills

## Library

`profiles/skills/library/` is a verbatim import of the remaining folders from
`/home/sr/Projects/Workspace/ws-knowledge/skills`. Supporting scripts, references,
agent metadata, and evaluation files are included. This copy makes the runtime
independent of that source directory. The existing `orch-*` team skills remain
outside the imported library.

Importing a folder does not execute its scripts, install its dependencies, or
connect an MCP server. For example, codebase indexing and search skills still
need their corresponding MCP services. These are governed by each role's
existing `a2a_tools.mcp_servers` policy.

## Selection

The runtime builds a trusted catalog from the library's `SKILL.md` metadata.
Each entry has an ID, description, local path, and SHA256 instruction hash.
The lead sees all compact IDs and a shortlist containing at most 12 relevant
descriptions. The shortlist uses lexical matching as a hint; the lead can choose
any trusted catalog ID based on the task's meaning, including tasks written in
a different language from the skill description.

Every new structured assignment includes `skills`, an array of zero to five
unique IDs. Unrelated tasks can use `[]`. Older assignment payloads without
`skills` continue to mean an empty selection.

The runtime resolves IDs to trusted files and creates `skillPins` containing
each selected ID and instruction hash. The lead does not supply file paths or
hashes. Both the assignment and its pins are retained in the dispatch checkpoint.

Before a worker starts, the A2A executor resolves and validates the selection.
The Codex client sends the selected skills as explicit `skill` input items in
`turn/start`. Full instruction bodies are loaded for selected skills only.
The global skill listing, plugins, apps, and existing MCP policy are unchanged.

## Boundaries and provenance

Selected skills are engineering guidance within the dispatched task. They cannot
override user, project, or role rules, the worker report schema, allowed paths,
sandbox permissions, or approval decisions. A skill that calls for a new agent,
git mutation, or custom report format does not grant that authority.

Unknown IDs, duplicate IDs, more than five IDs, invalid pins, unsafe paths, or
changed instruction files fail validation. Invalid A2A selections are rejected
before writer admission and before a model turn. Pending resumed dispatches
retain their original hashes rather than silently adopting a newer instruction.

Worker provenance and lead outcomes record selected skill IDs and instruction
hashes. Run context also records the catalog hashes so changes can be reported
after a restart.

## Current limits

The runtime selects skills before each assignment. A worker can report a missing
skill or tool to the lead, which can select it for a subsequent assignment;
there is no new mechanism for adding skills to an active turn.

Version pins cover `SKILL.md` contents. Supporting references and scripts are
bundled but are not independently version pinned. Skill availability is not a
filesystem isolation boundary: agents can still read files allowed by their
sandbox. Imported evaluation files are skill resources and are not executed
automatically by the orchestrator.

The import preserves existing source references. In particular, `agent-factory`
refers to `sources/factory_conductor_skill_spec_prompt.md`, which was absent from
the supplied skill folder. `entity-query-analyzer` also refers to a project-level
`New-MCP-Servers.md` outside the supplied library. These files are not invented or
downloaded during import; a task that needs them must report the missing context.
