# drupal-content

Read-only MCP server for inspecting a live Drupal content model through Drush. It describes entity types, bundles, fields, references, taxonomy, display modes, revisions, translations, moderation, menus, and permissions without modifying content or configuration.

## Requirements and installation

- PHP 8.1 or newer.
- mcp/sdk, symfony/process 6.x or 7.x, symfony/yaml 6.x or 7.x, and drupal-mcp/shared-args.
- A Drupal 10/11 project with a bootstrappable database.
- Drush through vendor/bin/drush, Lando, DDEV, or a global command.

~~~bash
composer require --dev drupal-mcp/content
# or
composer global require drupal-mcp/content
~~~

Root resolution is lazy and fully automatic. The server always starts and registers its tools immediately. The Drupal project root is resolved on the first tool call via: `PROJECT_ROOT` env, `--project-root` argument, local vendor install path, CWD ancestry, and finally the MCP client's workspace roots (`roots/list`).

The `roots/list` fallback covers IDE clients (Cursor, VS Code, and others) that spawn MCP servers from the home directory instead of the project: the server asks the client for its open workspace folders and picks the one that is, contains, or lives inside a Drupal project. When no root can be detected, tools return a structured `ENV_NOT_READY` error instead of the server failing to launch. This keeps a single global configuration working seamlessly across multiple Drupal projects. `DRUPAL_ROOT` is inferred from `web/core`, `docroot/core`, or the project root.

## MCP configuration

~~~json
{
  "mcpServers": {
    "drupal-content": {
      "command": "drupal-mcp-content"
    }
  }
}
~~~

For local installation, you can point the command to `vendor/bin/drupal-mcp-content`. For global installation, `--project-root` is no longer required because IDE clients provide the workspace roots automatically, and terminal clients detect the root from the CWD.

`DRUSH_OPTIONS_URI` and `DRUSH_URI` are forwarded to Drush as `--uri`.

## Response format and shared inputs

Successful and failed calls return ok, summary, data, counts, meta, and errors. Runtime calls use meta.execution = drush.

Tools using SharedArgsSchema accept optional limit (50), offset, sort, sort_direction (ASC or DESC), query, verbosity (minimal, normal, diagnostic, raw), summary_only, exclude_noise, and max_chars (10000).

## Tools

| Tool | Additional inputs | Output |
|---|---|---|
| inspect_entity_types | shared fields | Entity type ID, label, provider, and storage class. |
| inspect_bundles | entity_type_id; shared fields | Bundles for an entity type. |
| inspect_content_types | optional bundle; shared fields | Node bundle labels, revision support, and workflow assignment. |
| inspect_media_types | optional bundle; shared fields | Media bundles, source plugin IDs, and translation status. |
| inspect_taxonomy_models | optional vocabulary; shared fields | Vocabulary and taxonomy model summary. |
| inspect_field_usage | entity_type_id, optional bundle; shared fields | Field usage across all or one bundle. |
| inspect_reference_graph | shared fields as supported | Source bundle to target entity type and allowed target bundles for reference, image, and file fields. |
| summarize_editorial_model | required entity_type_id; optional bundle | Bundle count, reference edges, and moderation summary. |
| inspect_display_modes | required entity_type_id; optional bundle | View mode and form mode IDs. |
| inspect_revisioning | required entity_type_id; optional bundle | revisionable and revision_ui flags. The bundle is reserved for future scoping. |
| inspect_translation | required entity_type_id; optional bundle | translatable and module_enabled flags. |
| inspect_moderation | required entity_type_id; optional bundle | moderated flag, workflow ID, and workflow states. |
| inspect_fields | entity_type_id, optional bundle; shared fields | Field name, type, label, required, and translatable flags. |
| inspect_menus | shared fields | Menu IDs and labels. |
| inspect_vocabularies | shared fields | Vocabulary IDs and names. |
| inspect_permissions | shared fields | Permission key, label, and provider module. |

## Practical workflow

~~~text
inspect_entity_types(limit=25)
inspect_bundles(entity_type_id="node")
inspect_fields(entity_type_id="node", bundle="article")
summarize_editorial_model(entity_type_id="node", bundle="article")
inspect_moderation(entity_type_id="node", bundle="article")
~~~

## Development

~~~bash
php tests/run_smoke_tests.php
php bin/server.php
~~~
