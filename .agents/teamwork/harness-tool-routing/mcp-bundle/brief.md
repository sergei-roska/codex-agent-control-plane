# Drupal MCP bundle brief

## Goal

Copy the six audited Drupal MCP packages into Harness so future task-level MCP
routing can launch them from the repository. Exclude `drupal-browser` entirely.

## Verified context

- Source: `/home/sr/Projects/Workspace/mcp-forge`.
- Source has pre-existing deletions of `drupal-browser` and edits to all six
  remaining package Composer files, plus a behavior change in
  `drupal-config/src/Tools/TraceConfigDependencies.php`.
- The source edits are user work. Preserve source repository and all files as-is.
- Read-only audit is in `.agents/teamwork/harness-tool-routing/mcp-audit/report.md`.
- Packages to copy: `drupal-static`, `drupal-config`, `drupal-content`,
  `drupal-ops`, `drupal-render`, `drupal-db-ops`, and shared package `shared-args`.
- All tools are read-oriented, but five packages use Drush or direct DB access;
  `drupal-db-ops` includes `settings.php` to obtain database settings.
- User set a hard maximum of 5 selected MCP tools per task. This cap is not part
  of source bundle behavior.

## Ownership and allowed paths

You own only:

- `mcp/drupal/**`
- `profiles/mcp/catalog.json`
- `mcp/drupal/README.md`

Do not edit source worktrees, runtime code, role profiles, other docs, tests, or
Git state. Preserve unrelated dirty changes in Harness.

## Requirements

- Copy the six current source package trees and `shared-args`, including their
  source, package documentation, tests, Composer manifests, and lockfiles.
- Exclude all vendor directories, generated artifacts, and any `drupal-browser`
  content.
- Preserve the current source contents, including dirty user changes. Do not
  install Composer dependencies, run tests, or start MCP servers.
- Add a small root README with dependency setup instructions, list the six
  packages, describe root discovery and read-only/data-sensitivity boundaries,
  and state that the five-tool limit is enforced by Harness task routing.
- Create `profiles/mcp/catalog.json` with version, per-server config name,
  relative package path, short purpose, data sensitivity/runtime class, and
  every registered tool's exact MCP name plus concise description. Derive names
  and descriptions from the copied `bin/server.php` registrations and verify
  each listed name matches the entrypoint. Do not include full input schemas.
- Use stable config names prefixed `harness-` to avoid colliding with user MCP
  names. Keep source tool names unchanged.
- Report exact file counts, tool counts, omitted files/dependencies, commands
  used, and any mismatch. Do not claim runtime verification.

## Acceptance

- Exactly six Drupal server directories and shared-args are present.
- No vendor directory or `drupal-browser` content was copied.
- Catalog lists all 76 registered tools with exact names and descriptions.
- Only the owned paths changed; no test or server was run.
