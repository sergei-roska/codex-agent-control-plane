---
name: provision-ddev
description: Universal platform adapter for provisioning, configuring, and verifying DDEV environments for any preset (Drupal, WordPress, Laravel, Symfony, generic PHP, or custom stacks). Reads project type and docroot from preset defaults or falls back to generic.
---

# Provision DDEV Environment

## Purpose

Automates the provisioning and lifecycle of DDEV environments across supported framework presets and generic stacks.

## Inputs from Preset or Handoff

- `PROJECT_NAME`: Project name (required for stable hostname).
- `PROJECT_TYPE`: DDEV project type from preset (e.g. `drupal11`, `wordpress`, `laravel`, `php`, `generic`).
- `DOCROOT`: Web docroot path (e.g. `web`, `public`, `.`).
- `PHP_VERSION`: Optional PHP version override (e.g. `8.3`, `8.4`).
- `DATABASE`: Optional database type and version (e.g. `mariadb:11.8`, `mysql:8.0`, `postgres:16`).
- `SCAFFOLD_CMD`: Optional scaffolding command for greenfield setup.
- `INIT_CMD`: Optional site install / migration / seed command.
- `VERIFICATION_CMD`: Preset verification command (e.g. `drush status`, `wp core is-installed`, `php artisan`).

## Step-by-Step Procedure

### 1. Preflight and Cleanup

Verify DDEV is installed and Docker is operational:
```bash
ddev --version
ddev list
rm -f .gitkeep
```

### 2. Configure DDEV

Apply project configuration based on preset parameters:
```bash
ddev config \
  --project-name="${PROJECT_NAME:-my-app}" \
  --project-type="${PROJECT_TYPE:-php}" \
  --docroot="${DOCROOT:-web}" \
  ${PHP_VERSION:+--php-version="$PHP_VERSION"} \
  ${DATABASE:+--database="$DATABASE"}
```

Inspect generated `.ddev/config.yaml` to confirm chosen defaults.

### 3. Start Environment

```bash
ddev start -y
```

### 4. Scaffold Project (Greenfield only)

If scaffolding a new codebase, execute the scaffold command through DDEV:
```bash
if [ -n "$SCAFFOLD_CMD" ]; then
  eval "$SCAFFOLD_CMD"
fi
```

### 5. Initialize Site / Application

Run preset initialization (e.g. site install, database migrations):
```bash
if [ -n "$INIT_CMD" ]; then
  eval "$INIT_CMD"
fi
```

### 6. Verification

1. Derive direct HTTP URL:
```bash
URL=$(ddev describe -j 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["raw"]["httpurl"] ?? "";' 2>/dev/null || true)
[ -z "$URL" ] && URL=$(ddev describe | grep -Eo 'http://127.0.0.1:[0-9]+' | head -1)
echo "Derived URL: $URL"
```

2. Check HTTP endpoint reachability:
```bash
curl -skS -o /dev/null -D - --max-time 10 "$URL/" | grep -Ei '^HTTP'
```

3. Run preset verification command if defined:
```bash
if [ -n "$VERIFICATION_CMD" ]; then
  eval "$VERIFICATION_CMD"
fi
```

## References

See `references/ddev-provision-guide.md` for extended configuration and troubleshooting.
