# drupal-static

Offline MCP server for static Drupal codebase analysis. It scans files without bootstrapping Drupal, connecting to a database, running Drush, or starting a web server. PHP is parsed with nikic/php-parser; YAML is read with Symfony YAML; traversal uses Symfony Finder.

## Requirements and installation

- PHP 8.1 or newer.
- mcp/sdk, nikic/php-parser 5.7, symfony/yaml 8.1, symfony/finder 8.1, and drupal-mcp/shared-args.
- Read access to the Drupal project directory.
- A root containing composer.json and web/core, docroot/core, or core.

~~~bash
composer require --dev drupal-mcp/static
# or
composer global require drupal-mcp/static
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-static": {
      "command": "drupal-mcp-static"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-static`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

## Response format

Results contain ok, summary, data, counts, meta, and errors. meta.execution is none because all analysis happens on local files.

## Tools and inputs

All tools return arrays or summary records in data. Pagination and truncation are reflected in counts where the tool implements those options. Only read_sync_config uses the full SharedArgsSchema.

| Tool | Inputs | Output |
|---|---|---|
| list_custom_modules | no arguments | Custom module names, paths, and parsed info. |
| find_hook_implementations | hook_name; optional module and limit | Hook symbols, files, lines, and module names. hook_name omits the hook_ prefix. |
| find_service_definitions | optional service_id and class_name | Service IDs, classes, tags, modules, and source files. |
| find_event_subscribers | optional event_name | Subscriber classes, events, files, and modules. |
| find_plugin_classes | optional plugin_type and plugin_id | Plugin classes, IDs, types, files, and modules. |
| find_form_classes | required class_name | Matching form class, base class, file, and routes using it. |
| find_controller_handlers | optional route_name and path | Routing definitions mapped to controllers or form classes. |
| find_preprocess_functions | optional hook and theme | Preprocess function names, files, lines, and owners. |
| find_drush_commands | optional command_name | Drush command names, provider classes, and files. |
| trace_runtime_to_code | domain, identifier; optional secondary_identifier and limit (5) | Ranked code locations. domain is route, service, hook, preprocess, plugin, form_class, or entity_bundle. |
| summarize_code_inventory | no arguments | Narrative inventory of custom modules, routes, and services. |
| read_sync_config | optional config_name and pattern plus shared fields | Parsed YAML records with name, file_path, and data from config/sync/*.yml. |

read_sync_config accepts limit (50), offset, sort, sort_direction (ASC or DESC), query, verbosity (minimal, normal, diagnostic, raw), summary_only, exclude_noise, and max_chars (10000). Other tools use only the inputs listed in the table and do not accept these shared fields.

## Examples

~~~json
{"tool":"find_hook_implementations","arguments":{"hook_name":"node_insert","module":"my_module","limit":20}}
~~~

~~~json
{"tool":"read_sync_config","arguments":{"pattern":"node.type.","limit":25}}
~~~

~~~json
{"tool":"trace_runtime_to_code","arguments":{"domain":"route","identifier":"entity.node.canonical","limit":5}}
~~~

## Development

~~~bash
php tests/run_smoke_tests.php
php bin/server.php
~~~
