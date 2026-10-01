# Atlassian connector setup

Status: runtime and functional browser integration verified with local fixtures
on 2026-10-01, including a directly measured 390px viewport; live activation remains pending. This adapter
targets Atlassian Cloud OAuth 2.0 3LO. It does not reuse credentials from the Codex
Atlassian connector. Data Center authentication is not implemented.

## Operator-owned configuration

Register a dedicated Atlassian app with the read scopes `read:jira-work`,
`read:page:confluence`, and `offline_access`. Register the exact local callback:

```text
http://127.0.0.1:3000/api/dashboard/v1/integrations/atlassian/callback
```

Use the actual configured server port. `localhost` is also supported, but the
dashboard used to initiate authorization must use the same origin as the registered
callback. Host-only session cookies cannot transfer between `localhost` and
`127.0.0.1`. Begin rejects an origin mismatch; the UI links to the configured origin.

Create the config and secret/key files outside the configured workspace. The
config contains references only:

```json
{
  "clientId": "<registered-client-id>",
  "redirectUri": "http://127.0.0.1:3000/api/dashboard/v1/integrations/atlassian/callback",
  "tokenStorePath": "/home/operator/.config/orchestrator-atlassian/private/tokens.json",
  "clientSecretFile": "/home/operator/.config/orchestrator-atlassian/client-secret",
  "encryptionKeyFile": "/home/operator/.config/orchestrator-atlassian/encryption-key"
}
```

The client secret file contains the registered client secret as UTF-8 text; one
trailing line ending is accepted. The key file contains a random 32-byte key
encoded as 64 hexadecimal characters or 43 base64url characters. Files must be
owned by the server user and mode `0600`, with no symlink components. Keep the key
separate from the ciphertext and retain it across restarts. No default key is
generated and no plaintext token fallback exists.

The token store uses a private directory owned by the server user, mode `0700`;
the token file is mode `0600`. A write may create only the selected final directory
if its ancestor already exists. Health reads and disconnect do not create absent
storage. The record is encrypted with AES-256-GCM and bound to the configured
client, callback, and workspace. Changing that binding requires reconnecting.

Set the absolute path to the config before starting the existing server:

```sh
CODEX_ATLASSIAN_CONFIG=/home/operator/.config/orchestrator-atlassian/config.json PORT=3000 npm start
```

Without this variable the dashboard reports "Not configured" and remains usable
for direct tickets. Invalid explicit configuration fails startup with a redacted
configuration error. No secrets belong in the project, browser form, chat, or logs.

## Connection and source commands

1. Pair the browser with the local dashboard using its existing pairing flow.
2. Open Connections and connect Atlassian. Authorize the dedicated app.
3. The callback redirects to a fixed dashboard URL with an opaque handle. The
   dashboard removes the fragment and completes authorization using the same
   paired session. Codes and tokens stay server-side.
4. Load available sites and explicitly select one cloud site. Only granted Jira
   and Confluence read capabilities are selected. Unselected/inaccessible links
   stay visible as missing context.
5. Import a Jira issue key or immutable numeric issue ID. Repeated import opens
   the existing internal ticket. It never creates another run or silently refreshes
   the ticket's requirements.
6. Inspect source provenance and immutable saved snapshots in the ticket record.
   Refresh Source explicitly retrieves again. Changed available content creates
   a new requirement revision in Backlog. Otherwise it is saved as pending while
   active/settled work keeps its pinned inputs. Failed retrieval preserves the
   last successful snapshot and current evidence. "Changed" compares available
   content with the applied snapshot, so an outage followed by identical content
   is not a change and leaves nothing pending.

Local completion is internal completion. The connector has no issue, comment,
page, or status publication operation. OAuth token POSTs are authentication only.
The application single-instance lock also covers credential rotation; sharing a
token file between unrelated processes is unsupported.

## Egress audit

Every request to Atlassian passes through one guarded fetch
(`src/integrations/atlassian-egress.js`). Allowlist, enforced before the network:

- `POST https://auth.atlassian.com/oauth/token` (OAuth code exchange and refresh)
- `GET https://api.atlassian.com/oauth/token/accessible-resources`
- `GET https://api.atlassian.com/ex/jira/...` and `GET https://api.atlassian.com/ex/confluence/...`

Everything else (other hosts, other methods, userinfo, non-https, non-default ports) is
refused without a network call, fails with code `egress_denied`, and is recorded with
outcome `denied`. Each request is persisted as an `atlassian_egress` event in
`runtime_events` with method, host, path (no query string), status, outcome and
duration; headers, bodies and tokens are never recorded.

List recorded egress from the state database (default `.runtime/state.sqlite`, or
`$CODEX_A2A_STATE_DB`):

```sh
DB="${CODEX_A2A_STATE_DB:-.runtime/state.sqlite}"
sqlite3 -header "$DB" "SELECT sequence, occurred_at, json_extract(payload_json,'$.method') AS method, json_extract(payload_json,'$.host') AS host, json_extract(payload_json,'$.path') AS path, json_extract(payload_json,'$.status') AS status, json_extract(payload_json,'$.outcome') AS outcome FROM runtime_events WHERE type='atlassian_egress' ORDER BY sequence"
```

Violation check (must print no rows): any non-GET other than the token POST, or any
denied request:

```sh
sqlite3 -header "$DB" "SELECT sequence, occurred_at, payload_json FROM runtime_events WHERE type='atlassian_egress' AND ((json_extract(payload_json,'$.method') <> 'GET' AND NOT (json_extract(payload_json,'$.method')='POST' AND json_extract(payload_json,'$.host')='auth.atlassian.com' AND json_extract(payload_json,'$.path')='/oauth/token')) OR json_extract(payload_json,'$.outcome')='denied') ORDER BY sequence"
```

Without the `sqlite3` CLI, run the same check through the project's `better-sqlite3`
from the project root (prints a JSON array; `[]` means no violations):

```sh
DB="${CODEX_A2A_STATE_DB:-.runtime/state.sqlite}" node -e "
const db = new (require('better-sqlite3'))(process.env.DB, { readonly: true });
const rows = db.prepare(\"SELECT sequence, occurred_at, payload_json FROM runtime_events WHERE type='atlassian_egress'\").all()
  .map((r) => ({ ...r, p: JSON.parse(r.payload_json) }))
  .filter(({ p }) => p.outcome === 'denied' || (p.method !== 'GET' && !(p.method === 'POST' && p.host === 'auth.atlassian.com' && p.path === '/oauth/token')));
console.log(JSON.stringify(rows.map(({ p, ...r }) => r), null, 2));"
```

## Local verification

The dev harness has an explicit fixture mode with no live account or credentials:

```sh
DASHBOARD_DEV_DIR=/tmp/orchestrator-m6-qa DASHBOARD_DEV_SCENARIO=delivery DASHBOARD_DEV_ATLASSIAN_FIXTURES=1 CODEX_ATLASSIAN_CONFIG= PORT=38606 npm run dashboard:dev
```

This uses a disposable workspace and state directory. `DEMO-1` is a local fixture,
not an approved real Jira pilot. Fixture evidence proves persistence, routing,
and UI behavior; M6's live acceptance still requires approved feature/bugfix and
Confluence identities, real operator configuration, and actual Intake evidence.

## 401 and 403 semantics

A 401 from any Atlassian API call means the saved token was rejected (for example the app grant was revoked). Import and refresh then fail with `reconnect_required` (HTTP 409), write nothing, and Connections health reports `reconnect_required` until the account is reconnected. Stored tokens are not deleted. A 403 on a single issue or page is a per-document `unauthorized` entry in the source bundle (restricted content) and does not affect the connection.

A refresh token can keep working after the app grant is removed, in which case accessible-resources succeeds but no longer lists the selected site (or lists it without `read:jira-work`). Import and refresh treat that as the same authorization loss: `reconnect_required` (HTTP 409), nothing written, health `reconnect_required`, selected-site rows and stored tokens kept. Reconnect to clear it. A site that lacks only `read:page:confluence` keeps the per-document Confluence behavior.
