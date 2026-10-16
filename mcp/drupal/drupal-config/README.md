# drupal-config

Read-only MCP server for Drupal configuration intelligence. It queries active configuration through a Drupal runtime invoked by Drush and reads staged YAML from the sync directory. It inspects individual objects, dependencies, ownership, splits, recipes, drift, deployment impact, and allowlisted state values.

## Requirements and installation

- PHP 8.1 or newer.
- Composer dependencies: mcp/sdk, symfony/process 8.1, symfony/yaml 8.1, and drupal-mcp/shared-args.
- A Drupal project with composer.json and web/core, docroot/core, or core.
- Drush as project vendor/bin/drush, Lando Drush, DDEV Drush, or a global command.
- A bootstrappable Drupal site and database for active storage.
- A sync directory when staged configuration is required.

~~~bash
composer require --dev drupal-mcp/config
# or
composer global require drupal-mcp/config
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-config": {
      "command": "drupal-mcp-config"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-config`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

`DRUSH_OPTIONS_URI` and `DRUSH_URI` are forwarded to Drush as `--uri`.

## Response format

Every tool returns ok, summary, data, counts, meta, and errors. meta.execution is drush. The tools do not write configuration.

## Tools

| Tool | Inputs | Output |
|---|---|---|
| inspect_config_object | config_name; source = active, sync, or both; include_overrides (default true) | Active raw data, runtime overrides, sync YAML, or both. |
| trace_config_dependencies | config_name; max_depth (default 3); direction = requires, required_by, or both | Required and dependent configuration names. |
| find_config_owner | config_name | Module/theme ownership, install path, and confidence. |
| analyze_config_impact | config_name | Status, affected domains, risk level, dependents, and follow-up checks. |
| inspect_config_split_state | optional split_name | Split status, folder, complete/partial lists, and counts. |
| inspect_recipe_state | optional recipe_name | Recipe support and managed, missing, and changed counts. |
| summarize_deployment_risk | no arguments | Drift count, high-risk items, blockers, active-split checks, and recommendations. |
| debug_state_system | optional keys array, prefix, allowlist_profile = cron, maintenance, or update | Allowlisted Drupal State values. |
| diff_active_vs_sync | config_name; include_patch (default false) | Status, changed keys, risk, and optional active/sync payload. |
| detect_config_drift | optional prefix and shared pagination/filter fields | Drift items with name and operation plus counts and truncation metadata. |

Shared fields for detect_config_drift are limit (50), offset, sort, sort_direction (ASC or DESC), query, verbosity, summary_only, exclude_noise, and max_chars (10000).

## Examples

~~~json
{"config_name":"system.site","source":"both","include_overrides":true}
~~~

~~~json
{"config_name":"node.type.article","direction":"required_by","max_depth":2}
~~~

~~~json
{"prefix":"field.","limit":100,"sort":"name","sort_direction":"ASC"}
~~~

## Development

~~~bash
php tests/Smoke/run_tests.php
~~~
