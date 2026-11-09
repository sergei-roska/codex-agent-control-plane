# Dynamic MCP and skill routing handoff

Status: bundle copied; runtime routing and active-skill policy are implemented
and source-reviewed. Composer dependencies are installed in all six copied MCP
packages. No tests or runtime qualification have been run.

## User contract

- Maximum 5 skills and 5 concrete MCP tools per assignment; choose fewer when
  possible.
- User source roots: `/home/sr/Projects/Workspace/mcp-forge` and
  `/home/sr/Projects/Workspace/ws-knowledge/skills`. Preserve both dirty trees.
- Exclude `drupal-browser`; retain its deletion in the source tree.
- Do not start MCP servers, connect to Drupal or its database, or restart the
  Harness service as part of this task.

## Completed evidence

- Skill audit: `.agents/teamwork/harness-tool-routing/skill-audit-{a,b,c}/`.
  There are 33 current source folders: 5 KEEP, 17 ADAPT, 11 DEFER. The current
  per-skill durable decisions are in `docs/skill-routing-audit.md`. The 17
  ADAPT and 11 DEFER folders remain in the copied library but are excluded
  from task selection. `semantic-memory` is absent from the current tree and
  was separately deferred based on its previous Git blob.
- Additional comparison: 18 of 19 skills listed in
  `/home/sr/Projects/Workspace/agent-factory/.codex/skills` are already
  byte-identical to the Harness copy. `eval-ops` is absent and deferred, not
  imported, because its runner, telemetry, and prompt-optimization mandates do
  not match the Harness AUT-05 evaluation contract. See the added decision in
  `docs/skill-routing-audit.md`.
- External candidate reviewed: `madsnorgaard/drupal-agent-resources/drupal-expert`
  has useful Drupal practices but should be adapted before import. Its raw
  workflow includes site-mutating commands and third-party web research; its
  current skills.sh Snyk audit reports medium W011 exposure risk. No install or
  source modification occurred. Decision is recorded in `docs/skill-routing-audit.md`.
- MCP audit: `.agents/teamwork/harness-tool-routing/mcp-audit/report.md`.
  The six packages register 76 read-oriented tools. Five servers access live
  Drupal/DB data; `drupal-db-ops` loads executable `settings.php` for DB
  credentials.
- Bundle: `.agents/teamwork/harness-tool-routing/mcp-bundle/handoff.md`.
  Copied 151 source files across six server packages and `shared-args`, plus
  README and catalog. Names/descriptions statically match all entrypoints.
  Composer install completed for all six packages with `--no-scripts`; vendor
  directories are local ignored artifacts. Composer warned in each package
  that the lock file hash is stale relative to composer.json. No MCP process
  or live connection was started.
- Official Codex config reference documents MCP `command`, `args`, `cwd`,
  `env`, `enabled`, and `enabled_tools` fields. The Harness implementation uses
  thread config overrides and does not write the user's global config.

## Implementation state

- `profiles/skills/routing-policy.json` enables the 5 KEEP source skills and
  the internal AUT-03 lead skill only. Existing AUT-03 pin remains unchanged.
- `src/mcp-catalog.js` loads and pins the trusted 76-tool inventory.
- Assignment contract and lead prompt now carry `mcpTools`; max 5 is validated
  before dispatch. The lead receives a compact candidate shortlist plus trusted
  IDs and sensitivity notes.
- All 8 worker role profiles allowlist the six prefixed Drupal server names.
  The lead selects tools per assignment; Codex receives an exact
  `enabled_tools` allowlist for selected servers.
- A2A pins selected tools, records them in provenance and continuation
  metadata, and starts a fresh worker thread when a continuation changes the
  MCP tool set.
- `CodexAppServer` rejects selections outside the role allowlist and rejects
  selected packages without Composer autoload files before any model turn.
- `docs/skill-routing.md`, `docs/skill-routing-audit.md`, and
  `docs/mcp-routing.md` describe current policies and limitations.
- Source review traced lead selection, contract validation, A2A role allowlists,
  MCP thread configuration, and skill injection. Existing app-server skill
  examples now use `actor-model`, one of the five active skills, instead of
  excluded `entity-query-analyzer`.

## Constraints and pending work

- Do not modify either source worktree. Preserve pre-existing Harness edits in
  AUT-02/AUT-03, docs, tests, and source files.
- No tests were run. No MCP process, Harness restart, or live Drupal/DB access
  occurred. The Composer stale-lock warnings remain to be reviewed; dependencies
  were installed from the checked-in locks without scripts.
- Next runtime qualification step: run focused offline tests, then start selected
  MCPs against a non-production Drupal fixture. Live project access is separate
  and outside this migration.
