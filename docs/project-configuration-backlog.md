# Project configuration backlog

Status: planned for a future phase; outside the current beta and live-project
pilot. This backlog covers project-specific operator guidance and configuration
that should not be copied into the shared role profiles.

## PC-1: Project-specific rules for each role

Implementation status (2026-10-06): built on `feature/dashboard-integration` in
commit `8297082`. Schema version 7 stores revisions (`role_rules_revisions`,
`role_rules_current`) keyed by project, pack, and role; the API lives under
`/settings/roles/:roleRuntimeId/rules` (`src/dashboard-settings-api.js`,
`src/role-rules-store.js`). A run pins the effective rules in its settings snapshot
(`settings.projectRules`); they reach the role as `role.projectRules`, composed into
the developer instructions inside `src/codex-app-server.js` after the permission
profile is built, never through `role.instructions` (the profile derives a trusted
`TEAM.md` read path from that text). Known limits: a legacy-orch lead gets its rules
only when it has a settings entry in the pinned roles map; there is no dedicated
resume test (resume reads only pinned graph state); a Confluence link is plain text
in the prompt and is fetched only through tools the role already has.

### Context

Role profiles provide the shared system instructions. Workers also follow the
target repository's applicable `AGENTS.md` or `CLAUDE.md` instructions, but there
is no dashboard-managed, per-project and per-role rules overlay. Different
projects may have distinct environment setup and data-import procedures.

### Proposed experience

- In the **Connections & Models** Per-Role Model Defaults table, add a **System
  Prompt** column with an **Add rules** action for each role.
- The action opens a modal scoped to the current project and role. The top area
  shows existing added rules, or an empty state. The lower area contains a
  textarea for adding a new rule.
- Keep the shipped role system prompt intact. Show and manage project-specific
  additions as an overlay, not as an unrestricted replacement of the shared role
  contract.
- Example project rules may specify that the database is in the repository root
  and setup uses `lando pull`, or that database import and environment access use
  Terminus with Pantheon. Another rule may link to project documentation in
  Confluence.
- A Confluence link supplies context only when the project's Atlassian connection
  can retrieve it. A URL or prompt rule does not grant account access or broader
  network permissions.

### Behavior and boundaries

- Store rules by project/workspace, role pack, and role ID. Never leak rules from
  one project into another project's prompts.
- Version changes and record who changed them. Pin the effective rules revision
  to each new run; active and resumed runs keep their existing prompt snapshot.
- Removing or changing a rule affects new runs only. Provide a visible way to
  inspect current rules and their history.
- Include only the selected role's additions in that role's prompt context.
- Treat rules as guidance, not authorization. They cannot add tools, MCP servers,
  filesystem permissions, allowed paths, approved checks, credentials, or
  permission to perform external writes. Those capabilities remain controlled by
  project configuration and code-enforced policy.
- Keep environment operations explicit. Rules can describe the approved project
  workflow, but must not silently run database pulls/imports or production
  changes during setup.

### Acceptance evidence

- The modal renders the empty and populated states and saves a new rule for the
  selected project and role.
- A rule is present in that role's next run and absent from other roles and
  projects. The shared system prompt and roles without custom rules retain their
  current behavior.
- A run keeps its pinned rules after rules are edited or removed; a later run
  receives the new version.
- A Confluence URL is retrieved only through an authorized project connection;
  a bare link does not bypass source access policy.
- Project rules cannot change the role's tool allowlist, sandbox, permissions,
  approved checks, or external-operation authority.
