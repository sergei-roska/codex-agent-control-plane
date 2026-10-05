# Lando Provisioning Guide

Reference for configuring, starting, and troubleshooting Lando environments across presets.

## Supported Recipes

Lando natively supports common recipes:
- `drupal11`, `drupal10`, `drupal9`, `drupal8`, `drupal7`
- `wordpress`
- `laravel`, `symfony`
- `lamp`, `lemp` (generic Linux/Apache/Nginx/MySQL/PHP stacks)
- `mean` (MongoDB/Express/Angular/Node)
- `none` (custom services definition)

## Configuration Defaults

`lando init` creates `.lando.yml`. Key fields:
- `name`: App name
- `recipe`: Preset recipe (e.g. `drupal11`, `wordpress`, `laravel`, `lamp`)
- `config`:
  - `webroot`: Document root relative to app root (e.g. `web`, `public`, `.`)
  - `php`: PHP version (e.g. `8.3`, `8.4`)
  - `database`: DB type and version (e.g. `mysql:8.0`, `mariadb:10.11`, `postgres:16`)

## Scaffolding via Temp Directory

Composer `create-project` refuses non-empty directories. Because `.lando.yml` already exists in the project root, scaffold through a temporary subdirectory:

```bash
lando composer create-project <package> tmp --no-interaction
cp -r tmp/. . && rm -rf tmp
```

## Useful Commands

- `lando info`: URLs, service ports, DB credentials, container health.
- `lando info --format json`: Machine-readable info for dynamic URL derivation.
- `lando start`: Boot environment containers.
- `lando stop`: Halt environment containers (data preserved).
- `lando restart -y`: Restart containers (reassigns ephemeral host ports).
- `lando rebuild -y`: Rebuild environment after `.lando.yml` edits.
- `lando destroy -y`: Remove containers and volumes (code kept).
- `lando poweroff`: Stop all Lando projects.

## Dynamic URL Derivation

Host ports are ephemeral and change upon restart. Always derive the direct localhost URL:

```bash
URL=$(lando info --format json 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true);
  if(is_array($d)){ foreach($d as $s){ if(($s["service"]??"")==="appserver" || ($s["service"]??"")==="web"){
    foreach($s["urls"]??[] as $u){ if(str_starts_with($u,"http://localhost")){ echo $u; exit; } } } } }' 2>/dev/null || true)
echo "Derived URL: $URL"
```
