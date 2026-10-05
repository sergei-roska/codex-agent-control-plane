# Local Platform Preflight: Router Port Contention and URL Derivation

Platform-neutral reference shared by local development adapters (DDEV, Lando, Docker Compose).

## 1. Router Port Contention (Ports 80 and 443)

DDEV runs a shared `ddev-router` container; Lando runs a shared `landoproxyhyperion5000gandalfedition_proxy_1` container. Both attempt to bind host ports `80` and `443` for project hostnames (`*.ddev.site`, `*.lndo.site`).

Only one router can bind those ports at a time. The losing proxy starts with no published host ports:
- The `start` command still exits 0.
- Hostname-based URLs fail to connect or return a 404 from the competing router.
- A host web server (Nginx/Apache outside Docker) on port 80 causes the same issue.

### Preflight Diagnostics

```bash
# Check host listeners on 80/443/8000/8080
ss -ltn | grep -E ':(80|443|8000|8080)\s'

# Check Docker port bindings
docker ps --format '{{.Names}}\t{{.Ports}}'
```

### Checking Proxy Status

```bash
docker inspect <proxy-container-name> --format '{{json .NetworkSettings.Ports}}'
```

`{"443/tcp":null,"80/tcp":null}` indicates no ports are bound; hostname routing is disabled.

### Resolution Priorities

1. **Verify via direct localhost / ephemeral URL (Preferred):**
   Always derive and use the direct `http://127.0.0.1:<port>` or `http://localhost:<port>`. Hostname routing is optional for automation.
2. **Stop the competing platform router:**
   `ddev poweroff` or `lando poweroff` (only with explicit user confirmation).
3. **Configure custom router ports:**
   DDEV: `router_http_port` / `router_https_port` in `.ddev/config.yaml`.
   Lando: `proxyHttpPort` / `proxyHttpsPort` in `~/.lando/config.yml`.

## 2. Host Port Ephemeral Reassignment

Both platforms assign dynamic host ports. Lando reassigns them on every start or restart.

Rule: Always derive the URL dynamically from the active runtime after each start or restart. Never hardcode or reuse ports across sessions.

```bash
# DDEV URL derivation
ddev describe
URL=$(ddev describe -j 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true); echo $d["raw"]["httpurl"] ?? "";' 2>/dev/null || ddev drush status --field=uri 2>/dev/null || true)

# Lando URL derivation (direct localhost)
URL=$(lando info --format json 2>/dev/null | php -r '$d=json_decode(file_get_contents("php://stdin"),true);
  if(is_array($d)){ foreach($d as $s){ if(($s["service"]??"")==="appserver" || ($s["service"]??"")==="web"){
    foreach($s["urls"]??[] as $u){ if(str_starts_with($u,"http://localhost")){ echo $u; exit; } } } } }' 2>/dev/null || true)
```

## 3. Universal Verification Protocol

1. Container status: Ensure all required services report healthy / running.
2. Dynamic URL derivation: Query active runtime info for direct HTTP endpoint.
3. HTTP Response: `curl -skS -o /dev/null -D - --max-time 10 "$URL/"` must return HTTP 200 or 302.
4. CLI / Runtime status: Execute preset-specific status check (e.g. `drush status`, `wp core is-installed`, `php artisan --version`, or custom healthcheck).
5. Database connection: Confirm database connectivity if the project uses a database.
