---
name: provision-local-platform
description: Universal orchestrator for provisioning and running local development environments across supported platforms (DDEV, Lando, Docker Compose) for any stack preset (Drupal, WordPress, Laravel, Symfony, Django, Next.js, generic PHP/Node). Directs preflight port contention checks, platform adapter execution, and universal reachability verification.
---

# Provision Local Platform (Orchestrator)

## Purpose

Provides a universal, stack-agnostic workflow for bootstrapping, configuring, and verifying local development environments. Directs execution to dedicated platform adapters (`provision-ddev`, `provision-lando`).

## Inputs and Preset Parameters

The orchestrator reads stack-specific configuration from the active preset (`presets/<preset>.md`) or handoff:

| Parameter | Source | Description |
|---|---|---|
| Platform | Required user / handoff input | `ddev` or `lando` |
| Target directory | Required user / handoff input | Project root directory (must be clean for greenfield) |
| Project name | Directory basename or override | Hostname and container prefix |
| DDEV project type | Preset or fallback `php`/`generic` | e.g. `drupal11`, `wordpress`, `laravel`, `symfony`, `php` |
| Lando recipe | Preset or fallback `lamp`/`none` | e.g. `drupal11`, `wordpress`, `laravel`, `symfony`, `lamp` |
| Webroot | Preset or default | Document root (e.g. `web`, `public`, `docroot`, `./`) |
| Scaffold command | Preset or custom | Initial project creation command if greenfield |
| Init / install command | Preset or custom | Site installation, migration, or build command |
| Verification check | Preset or generic | CLI healthcheck (e.g. `drush status`, `wp core is-installed`, `php artisan`) |

## Workflow

### 1. Preflight and Port Contention Check

- Check platform CLI availability (`ddev --version` or `lando version`) and Docker engine status (`docker info`).
- Inspect target directory. If not empty on greenfield, require explicit user authorization.
- Run port contention check from `references/local-platform-preflight.md` to identify existing listeners on `80`/`443`.
- List existing platform projects (`ddev list` or `lando list`) to prevent name or port collisions.

### 2. Route to Platform Adapter

- **DDEV:** Invoke `provision-ddev`.
- **Lando:** Invoke `provision-lando`.
- **Custom / Fallback:** If the target stack lacks a dedicated recipe, the adapter configures a generic runtime (`generic`/`php` on DDEV, `lamp`/`lemp`/custom services on Lando) and uses the preset commands.

### 3. Universal Verification Checklist

Execute in order:
1. **Container health:** Verify all required service containers report healthy.
2. **Dynamic URL derivation:** Query active runtime for the direct HTTP URL (`http://127.0.0.1:<port>` or `http://localhost:<port>`). Never rely solely on configured hostname URLs.
3. **HTTP endpoint check:** `curl -skS -o /dev/null -D - --max-time 10 "$URL/"` returning HTTP 200 or 302.
4. **CLI / Service check:** Run the preset verification command inside the container environment.
5. **Database verification:** Verify database connection if the stack requires a database.

### 4. Cleanup and Boundaries

- Never perform destructive operations (`delete -Oy`, `destroy -y`, volume wipes) without explicit target confirmation from the user.
- To safely reset, prefer directory renaming or standard non-destructive container stops (`ddev stop` / `lando stop`).
