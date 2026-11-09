# Drupal MCP bundle handoff

Status: complete.

Copied current source contents from `/home/sr/Projects/Workspace/mcp-forge` to
`mcp/drupal`, preserving dirty source edits. Per-package copied regular-file
counts (excluding vendor): `drupal-static` 35, `drupal-config` 23,
`drupal-content` 25, `drupal-ops` 22, `drupal-render` 18, `drupal-db-ops` 22,
and `shared-args` 6. Total: 151 files (145 server-package files and 6 shared
package files). The README and `profiles/mcp/catalog.json` are additional Harness
files, not source-copy counts.

The catalog lists 76 tools: static 12, config 10, content 16, ops 14, render
10, and db-ops 14. A static parser compared every catalog name and description
to the corresponding copied `bin/server.php` registration; all matched. The
root README documents package dependency setup, root discovery, data
sensitivity/runtime boundaries, and the Harness-enforced five-tool task cap.

Commands used: `cat` for the assigned worker settings, project context, task
brief, prior handoff, and audit report; `git status --short` and
`git diff -- .agents/teamwork/harness-tool-routing/mcp-bundle` for initial
state; `find` and `rg` for source inventories and entrypoint registrations;
`rsync -a --exclude='/vendor/' <source-package>/ mcp/drupal/<package>/` for each
of the seven packages; inline Python for catalog generation and static
acceptance checks; `diff -qr --exclude=vendor <source-package> mcp/drupal/<package>`
for each server package and `diff -qr <source-shared-args> mcp/drupal/shared-args`;
and `git diff --check -- mcp/drupal profiles/mcp/catalog.json`. All static
checks and diffs passed. The static check confirmed exactly six server
directories plus `shared-args`, 151 copied files, byte-identical source copies,
76 exact registered tool names/descriptions, and no vendor or `drupal-browser`
content.

Excluded: all vendor directories and all `drupal-browser` content. No generated
artifacts were present in the seven included package trees. No tests, Composer
installs, MCP processes, runtime behavior checks, or Git mutations were run.
Runtime launchability and behavior remain unverified. Existing unrelated Harness
dirty state and source-tree dirty state were preserved.
