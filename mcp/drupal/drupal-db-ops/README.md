# drupal-db-ops

Database-only MCP server for Drupal diagnostics. It reads settings.php, connects with PDO, and queries Drupal tables directly. It does not load the Drupal kernel, call Drush, or require a running Drupal container.

## Requirements and installation

- PHP 8.1 or newer.
- mcp/sdk, symfony/process 6.x or 7.x, symfony/yaml 6.x or 7.x, and drupal-mcp/shared-args.
- A Drupal project with sites/default/settings.php.
- PDO and a MySQL/MariaDB or PostgreSQL PDO driver.
- Database credentials in the $databases variable of settings.php.

~~~bash
composer require --dev drupal-mcp/db-ops
# or
composer global require drupal-mcp/db-ops
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-db-ops": {
      "command": "drupal-mcp-db-ops"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-db-ops`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

The adapter reads `DRUPAL_ROOT/sites/default/settings.php`, supports nested and legacy database arrays, and applies Drupal table prefixes. The database connection is lazy and opens on the first operation.

## Response format

Results contain ok, summary, data, counts, meta, and errors. meta.execution is pdo. Database failures are structured and the tools do not mutate the database.

## Tools

### Diagnostics

| Tool | Inputs | Output |
|---|---|---|
| debug_watchdog | wid, severity, type, query, since, until, uid, limit (50) | Watchdog records filtered by ID, severity, channel, message, time, or user. |
| debug_queue_state | queue_name, include_claimed (false), include_failed_samples (false) | Queue sizes, claimed items, and optional failed/stale samples. |
| debug_cron_state | include_recent_runs (false) | Cron timestamps, status, lock state, and optional recent run logs. |
| debug_cache_state | bin, include_size_estimate (false), include_stale_samples (false) | Cache bins, counts, stale metrics, and optional CIDs. |
| debug_update_state | include_pending (false), include_failed (false) | Schema versions, pending update hooks, and failure indicators. |
| debug_environment_summary | include_runtime_versions (false) | Drupal version, maintenance mode, database details, and optional runtime versions. |
| debug_state_system | keys array, prefix, allowlist_profile | Allowlisted Drupal State values. |
| debug_runtime_health | include_domains (false), include_recommendations (false) | Aggregate health status, warnings, and recommendations. |
| debug_failed_operations | since, severity_threshold (3), domains array | Cross-domain failures from watchdog, queues, cron, and updates. |

### Configuration diagnostics

| Tool | Inputs | Output |
|---|---|---|
| inspect_config_object | required config_name; source = active, sync, or both | Active DB and/or sync YAML object. |
| diff_active_vs_sync | required config_name; include_patch (false) | Status, changed keys, risk level, and optional active/sync payload. |
| detect_config_drift | optional prefix and shared filters | Drift items and operation counts. |
| analyze_config_impact | required config_name | Deployment risk, affected domains, dependents, and follow-ups. |
| summarize_deployment_risk | no arguments | Overall drift, high-risk objects, blockers, and suggested checks. |

For detect_config_drift, shared fields are limit (50), offset, sort, sort_direction, query, verbosity, summary_only, exclude_noise, and max_chars.

## Examples

~~~json
{"tool":"debug_runtime_health","arguments":{"include_domains":true,"include_recommendations":true}}
~~~

~~~json
{"tool":"inspect_config_object","arguments":{"config_name":"system.site","source":"both"}}
~~~

~~~json
{"tool":"detect_config_drift","arguments":{"prefix":"field.","limit":25}}
~~~

## Development

~~~bash
php tests/run_smoke_tests.php
php bin/server.php
~~~
