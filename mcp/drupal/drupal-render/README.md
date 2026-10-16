# drupal-render

Read-only MCP server for Drupal theme and render-pipeline inspection. It runs PHP snippets through Drush against a bootstrapped site and follows the path from active theme and block placement to render arrays, template suggestions, preprocess functions, libraries, and Single Directory Components.

## Requirements and installation

- PHP 8.1 or newer.
- mcp/sdk, symfony/process 6.x or 7.x, symfony/yaml 6.x or 7.x, and drupal-mcp/shared-args.
- Drupal 10/11 site with database and a bootstrappable Drupal container.
- Drush through vendor/bin/drush, Lando, DDEV, or a global command.

~~~bash
composer require --dev drupal-mcp/render
# or
composer global require drupal-mcp/render
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-render": {
      "command": "drupal-mcp-render"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-render`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

`DRUSH_OPTIONS_URI` and `DRUSH_URI` are forwarded to Drush as `--uri`.

## Response format

The common envelope contains ok, summary, data, counts, meta, and errors. meta.execution is drush. Tools are read-only.

## Tools

| Tool | Inputs | Output |
|---|---|---|
| inspect_theme_state | none | Active front-end/admin themes, base-theme chain, regions, and paths. |
| inspect_template_suggestions | theme_hook | Candidate template filenames in priority order. |
| trace_template_resolution | theme_hook | Template filename/path/type and preprocess functions. |
| find_preprocess_chain | theme_hook | Ordered preprocess functions. |
| inspect_render_array | target_type = node or block; target_id; optional view_mode (full); max_depth (3) | Sanitized render-array structure. |
| inspect_library_attachments | target_type; target_id | Attached libraries and drupalSettings keys. |
| inspect_blocks_and_regions | optional region | Active-theme placements, plugins, weights, and status. |
| inspect_sdc_components | optional component_id | All SDC definitions or one full definition; requires SDC support. |
| summarize_render_path | target_type; target_id | Theme hook, template, preprocess count, and attached libraries. |
| inspect_themes | shared filters | Installed themes, labels, default/admin flags, and enabled status. |

## Examples

~~~json
{"tool":"inspect_theme_state","arguments":{}}
~~~

~~~json
{"tool":"inspect_render_array","arguments":{"target_type":"node","target_id":"42","view_mode":"full","max_depth":4}}
~~~

~~~json
{"tool":"inspect_sdc_components","arguments":{"component_id":"my_theme:card"}}
~~~

## Development

~~~bash
php tests/run_smoke_tests.php
php bin/server.php
~~~
