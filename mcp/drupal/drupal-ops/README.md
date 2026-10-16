# drupal-ops

Runtime operations and debugging MCP server for a bootstrapped Drupal site. It uses Drush to inspect logs, queues, cron, cache, updates, health, modules, services, plugins, routes, and runtime registries. All tools are read-only.

## Requirements and installation

- PHP 8.1 or newer.
- mcp/sdk, symfony/process 6.x or 7.x, symfony/yaml 6.x or 7.x, and drupal-mcp/shared-args.
- A Drupal project and database that Drush can bootstrap.
- Drush through vendor/bin/drush, Lando, DDEV, or a global command.

~~~bash
composer require --dev drupal-mcp/ops
# or
composer global require drupal-mcp/ops
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-ops": {
      "command": "drupal-mcp-ops"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-ops`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

`DRUSH_OPTIONS_URI` and `DRUSH_URI` are forwarded to Drush as `--uri`.

## Response format

The common envelope contains ok, summary, data, counts, meta, and errors. meta.execution is drush. There are no resources or prompts, and tools do not mutate the site.

## Tools

### Runtime diagnostics

| Tool | Inputs | Output |
|---|---|---|
| debug_watchdog | wid, severity, type, query, since, until, uid, limit (50) | Filtered watchdog records. |
| debug_queue_state | queue_name, include_claimed, include_failed_samples | Queue backlog and optional claimed/failed samples. |
| debug_cron_state | include_recent_runs | Cron timestamps, status, locks, and recent logs. |
| debug_cache_state | bin, include_size_estimate, include_stale_samples | Cache bins, counts, and stale samples. |
| debug_update_state | include_pending, include_failed | Schema versions and pending/failed updates. |
| debug_environment_summary | include_runtime_versions | Drupal and database environment summary. |
| debug_state_system | keys array, prefix, allowlist_profile | Allowlisted Drupal State values. |
| debug_runtime_health | include_domains, include_recommendations | Aggregate health status and optional remediation advice. |
| debug_failed_operations | since, severity_threshold (3), domains array | Failures across watchdog, queues, cron, and updates. |

### Runtime registries

| Tool | Inputs | Output |
|---|---|---|
| inspect_modules | shared filters | Enabled modules with machine name, label, and version. |
| inspect_services | limit (50), offset, query | Service IDs and class names. |
| inspect_plugins | shared filters | Supported plugin instances. |
| inspect_routes | limit (50), offset, query | Route names, paths, controllers, and requirements. |
| search_runtime_objects | query string | Cross-search over entity types, modules, and routes. |

Shared fields used by the registry tools where supported: limit, offset, sort, sort_direction, query, verbosity, summary_only, exclude_noise, and max_chars.

## Examples

~~~json
{"tool":"debug_watchdog","arguments":{"severity":"3","query":"exception","since":"-24 hours","limit":20}}
~~~

~~~json
{"tool":"inspect_routes","arguments":{"query":"/admin","limit":25}}
~~~

~~~json
{"tool":"search_runtime_objects","arguments":{"query":"article"}}
~~~

## Development

~~~bash
php tests/run_smoke_tests.php
php bin/server.php
~~~
