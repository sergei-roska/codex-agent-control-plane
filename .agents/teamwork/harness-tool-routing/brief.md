# Dynamic MCP tool and skill routing

## Objective

Integrate user-provided custom MCP servers/tools and skills into Harness so
each agent receives a minimal task-relevant subset under enforced caps.

## Acceptance direction

- Select skills per assignment and MCP tools per assignment, not as a blanket
  project-wide or role-wide bundle.
- Minimize irrelevant tool and instruction context while preserving task
  capability; an empty selection is valid.
- Enforce role/system maximums in trusted runtime code, independent of model
  proposals.
- Validate each selection against user-approved catalogs and role permissions.
- Pin selected resource identities/versions in task and attempt evidence, and
  pass only the selected resources to the corresponding agent turn.
- Preserve existing sandbox, approval, read/write, review, pause, budget, and
  acceptance gates.

## Verified current state

- Skill assignment is already dynamic, with a hard maximum of 5 skills per
  assignment (`src/contracts.js`, `src/lead-graph.js`).
- MCP exposure is static per role through `profiles/agents/*.toml`;
  `src/codex-app-server.js` enables/disables whole named MCP servers. There is
  no per-assignment or individual MCP-tool selection today.
- The user's CODEX_HOME currently lists MCP servers named `filesystem` and
  `memory`; their configuration values were not copied into notes.
- `filesystem` has broad roots including a workspace tree and profile home.
- The only top-level custom skill found is `delegate`. It is Codex lead
  orchestration guidance and references host-specific files and subagent
  dispatch, so it cannot be copied unchanged into the Harness agent library.
- User has not yet identified the source directories/resources to import or
  selected role/tool caps. No files were edited and no MCP was enabled.

## Next action

Audit the Drupal MCP projects under `/home/sr/Projects/Workspace/mcp-forge`,
excluding `drupal-browser`, and individually assess every skill under
`/home/sr/Projects/Workspace/ws-knowledge/skills`. Preserve both source
worktrees' existing modifications/deletions. Inventory names, descriptions,
exposed tools, dependencies, roots, and skill references without exposing
secrets. Propose task-level routing, permission caps, and evidence design before
enabling access.
