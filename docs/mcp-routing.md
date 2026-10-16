# Per-assignment Drupal MCP routing

## Catalog and policy

`mcp/drupal/` contains six Drupal MCP packages and `shared-args`, copied from
the current `mcp-forge` source tree. `drupal-browser` was excluded. The catalog
in `profiles/mcp/catalog.json` records 76 registered tools with exact MCP tool
names and concise descriptions. Package README files and current source edits
were preserved. Vendor folders and generated files were not copied.

Every role profile allowlists the six prefixed `harness-drupal-*` server names.
That is the role-level ceiling. It does not enable these imported servers by
itself: the lead selects `mcpTools` for each assignment, using trusted IDs of
the form `harness-drupal-static:list_custom_modules`. The assignment schema and
runtime reject unknown IDs, tools outside the role allowlist, duplicate IDs,
and more than five tools. The lead is instructed to use an empty list by
default and select the minimum useful set. There is no separate server-count
limit; at most five selected tools can activate at most five servers.

The catalog loader pins each selected ID to its catalog and package metadata.
Dispatch records the selected tool pins. A new task that resumes an earlier
worker thread may reuse that thread only when its selected MCP tool set is
unchanged; otherwise the worker starts a fresh Codex thread. This avoids
changing a thread's tool surface mid-conversation.

## Runtime behavior

For a task with selected Drupal tools, Harness supplies transient Codex config
overrides at thread start or resume. It defines each needed stdio server with a
trusted local `php` command and package entrypoint, sets the package working
directory and target `PROJECT_ROOT`, and sets `enabled_tools` to exactly the
selected names for that server. Other imported Drupal servers are disabled for
that thread. Harness does not write these definitions to the user's global
Codex config. Codex documents the `command`, `args`, `cwd`, `env`, `enabled`,
and `enabled_tools` MCP config fields in its
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Before a selected server can be launched, its package must have
`vendor/autoload.php`. If dependencies are absent, Harness rejects the task
before starting a model turn. Install Composer dependencies separately in each
package as described in `mcp/drupal/README.md`; this import did not install
them.

## Data boundaries

`drupal-static` reads local source and sync configuration files. The other five
servers query live Drupal or a database and may return sensitive configuration,
state, permissions, render output, logs, or operational data. `drupal-db-ops`
includes the target project's executable `sites/default/settings.php` to
obtain DB credentials. The lead prompt recommends live tools only when the task
needs that data and calls out the DB package's additional boundary. These
packages are read-oriented; that does not make their results nonsensitive.

## Verification status

Static audit matched the 76 catalog tool names and descriptions to package
entrypoint registrations and confirmed the copied source files. No Composer
dependencies were installed, MCP process was launched, or live Drupal/DB
connection was made. Runtime startup and tool visibility remain unverified.
