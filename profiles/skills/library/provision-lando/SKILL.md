---
name: provision-lando
description: Universal platform adapter for provisioning, configuring, and verifying Lando environments for any preset (Drupal, WordPress, Laravel, Symfony, generic LAMP/LEMP, or custom stacks). Reads recipe and webroot from preset defaults or falls back to generic.
---

# Provision Lando Environment

## Purpose

Automates the provisioning and lifecycle of Lando environments across supported framework presets and generic stacks.

## Inputs from Preset or Handoff

- `PROJECT_NAME`: Project name (required for container naming).
- `RECIPE`: Lando recipe from preset (e.g. `drupal11`, `wordpress`, `laravel`, `lamp`, `lemp`, `none`).
- `WEBROOT`: Document root path (e.g. `web`, `public`, `.`).
- `SCAFFOLD_CMD`: Optional scaffolding command for greenfield setup.
- `INIT_CMD`: Optional site install / migration / seed command.
- `VERIFICATION_CMD`: Preset verification command (e.g. `drush status`, `wp core is-installed`, `php artisan`).

## Step-by-Step Procedure

### 1. Preflight and Cleanup

Verify Lando is installed and Docker is operational:
```bash
lando version
lando list
rm -f .gitkeep
```

### 2. Configure Lando

Initialize Lando configuration based on preset parameters:
```bash
lando init \
  --source cwd \
  --name "${PROJECT_NAME:-my-app}" \
  --recipe "${RECIPE:-lamp}" \
  --webroot "${WEBROOT:-web}" \
  --yes
```

Inspect generated `.lando.yml` to confirm defaults.

### 3. Start Environment

```bash
lando start
```

### 4. Scaffold Project (Greenfield only)

Because `.lando.yml` exists in the target root, scaffold through a temporary subdirectory:
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

1. Derive direct localhost HTTP URL:
```bash
URL=$(lando info --format json 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true);
  if(is_array($d)){ foreach($d as $s){ if(($s["service"]??"")==="appserver" || ($s["service"]??"")==="web"){
    foreach($s["urls"]??[] as $u){ if(str_starts_with($u,"http://localhost")){ echo $u; exit; } } } } }' 2>/dev/null || true)
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

See `references/lando-provision-guide.md` for recipe defaults and connection details.
