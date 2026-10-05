# DDEV Provisioning Guide

Reference for configuring, starting, and troubleshooting DDEV environments across presets.

## Supported Project Types

DDEV natively supports standard project types:
- `drupal11`, `drupal10`, `drupal9`, `drupal8`, `drupal7`
- `wordpress`, `wp-bedrock`
- `laravel`, `symfony`, `cakephp`, `codeigniter`
- `magento`, `magento2`, `shopware6`, `typo3`
- `php` (generic PHP application)
- `generic` (custom stack, Python/Node/etc.)

## Configuration Defaults

`ddev config` populates `.ddev/config.yaml`. Common flags:
- `--project-name=<name>`: Explicit project name (prevents host collision).
- `--project-type=<type>`: Preset-specified type or `php`/`generic`.
- `--docroot=<path>`: Document root relative to project (e.g. `web`, `public`, `.`).
- `--php-version=<version>`: e.g. `8.3`, `8.4`.
- `--database=<type>:<version>`: e.g. `mariadb:11.8`, `mysql:8.0`, `postgres:16`.

## Scaffolding Rules

- DDEV enforces an allowlist on project root when running `ddev composer create-project`.
- Existing files (like stray `.gitkeep` or readme) must be removed before scaffolding, or scaffold into a temporary subdirectory and move files over (`cp -r tmp/. . && rm -rf tmp`).

## Useful Commands

- `ddev describe`: Overview of services, status, credentials, and derived URLs.
- `ddev start`: Launch environment containers.
- `ddev stop`: Stop environment (data and volumes preserved).
- `ddev exec <command>`: Run command inside the web container.
- `ddev composer <args>`: Run Composer inside the container runtime.
- `ddev logs -s web` / `ddev logs -s db`: View container logs.
- `ddev delete -Oy`: Teardown project and DB volume (code on disk untouched).
- `ddev poweroff`: Stop all DDEV projects and router.

## Dynamic URL Derivation

```bash
ddev describe
URL=$(ddev describe -j 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["raw"]["httpurl"] ?? "";' 2>/dev/null || true)
if [ -z "$URL" ]; then
  # Fallback to direct HTTP port from describe table
  URL=$(ddev describe | grep -Eo 'http://127.0.0.1:[0-9]+' | head -1)
fi
```
