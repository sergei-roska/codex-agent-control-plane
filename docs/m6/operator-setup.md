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
   last successful snapshot and current evidence.

Local completion is internal completion. The connector has no issue, comment,
page, or status publication operation. OAuth token POSTs are authentication only.
The application single-instance lock also covers credential rotation; sharing a
token file between unrelated processes is unsupported.

## Local verification

The dev harness has an explicit fixture mode with no live account or credentials:

```sh
DASHBOARD_DEV_DIR=/tmp/orchestrator-m6-qa DASHBOARD_DEV_SCENARIO=delivery DASHBOARD_DEV_ATLASSIAN_FIXTURES=1 CODEX_ATLASSIAN_CONFIG= PORT=38606 npm run dashboard:dev
```

This uses a disposable workspace and state directory. `DEMO-1` is a local fixture,
not an approved real Jira pilot. Fixture evidence proves persistence, routing,
and UI behavior; M6's live acceptance still requires approved feature/bugfix and
Confluence identities, real operator configuration, and actual Intake evidence.
