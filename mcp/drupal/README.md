# Harness Drupal MCP bundle

This directory contains six task-routed Drupal MCP servers and the shared
`shared-args` package, copied from the current `mcp-forge` source tree.

## Packages

- `drupal-static` - local source code and configuration file inspection.
- `drupal-config` - active and synchronized Drupal configuration inspection.
- `drupal-content` - content model, fields, bundles, and permissions inspection.
- `drupal-ops` - runtime health, logs, queues, and registry inspection.
- `drupal-render` - theme, template, and render structure inspection.
- `drupal-db-ops` - direct SQL diagnostics and configuration inspection.
- `shared-args` - common project-root discovery and argument definitions.

## Dependency setup

Install dependencies for each server package from its own directory with
Composer. The packages use a local path repository for `../shared-args`; keep
the package directory layout intact. `drupal-static` needs its declared PHP
libraries only. The other Drupal packages need an accessible, bootstrappable
Drupal project and the Drush or database dependencies described in each
package manifest and README. `drupal-db-ops` reads `sites/default/settings.php`
to obtain connection settings. Do not treat database credentials or returned
runtime data as nonsensitive.

## Discovery and boundaries

The shared root resolver checks `PROJECT_ROOT`, `--project-root`, package
installation ancestry, current-directory ancestry, and then MCP client roots.
The Drupal root is selected from `DRUPAL_ROOT`, `web`, `docroot`, or the
project root. Review the selected root before routing a task. `drupal-static`
reads local files. The other servers can query live Drupal or its database and
may return configuration, state, permissions, render data, logs, or other
sensitive operational information. The tools are read-oriented, but that does
not make their results low-sensitivity. The database server includes the
project's executable `settings.php` and connects using its settings.

Harness task routing enforces a maximum of five selected MCP tools per task.
This limit belongs to Harness routing and is not implemented by these source
packages.
