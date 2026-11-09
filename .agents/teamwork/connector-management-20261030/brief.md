# Brief: Connector controls

## Objective
Let the user disable/enable a connector for agent use without deleting its OAuth credentials, and switch the connector's service account through an explicit local logout + OAuth sign-in flow.

## Sourced decisions and verified context
- User chose disable-for-agents while preserving credentials, and switching the connector's service account (not binding a separate Codex profile).
- `docs/codex-accounts-design.md` says the active Codex profile is launcher-wide. `src/launcher-app.js` passes its active `CODEX_HOME` to connector status/sign-in.
- `src/connector-status.js` currently forces every catalog connector enabled for status/sign-in and only exposes sign-in; the task `CodexAppServer._toolPolicy` independently turns selected connector servers on.
- The installed CLI supports `codex mcp logout <NAME>`. Current Codex docs say this removes local OAuth credentials only; it does not revoke provider-side access.

## Contract (fixed for parallel implementation)
- Preferences are persisted atomically as `{ "version": 1, "disabled": [<connector-name>, ...] }` in `connector-preferences.json` under the configured `accountProfiles.accountsDir` (mode 0600). Missing file means all connectors enabled.
- `GET /api/connectors` retains existing fields and adds `enabled: boolean` per connector.
- `PUT /api/connectors/:name/enabled` accepts exactly `{ enabled: boolean }`, persists the reversible preference, and returns `{ success: true, name, enabled }`.
- `POST /api/connectors/:name/switch-account` removes only the named connector's local OAuth credential from the currently active Codex home via `codex mcp logout <name>`, then starts the existing OAuth sign-in and returns `{ authUrl }`. It does not revoke remotely. No external OAuth flow starts until the user clicks the UI action.
- Disabled connectors must not be exposed to a new App Server turn. In-flight turns are not interrupted; disable applies to the next tool-policy/turn evaluation.
- Existing `POST /api/connectors/:name/sign-in` behavior remains for first-time sign-in.

## UX constraints
- Every connector row offers Enable/Disable.
- Connected OAuth rows offer Switch account. This action has an inline confirmation (no native dialog) explaining that the saved local connector sign-in for the current active Codex profile will be cleared, then opens the OAuth flow.
- Disabled-but-authenticated connectors are visibly marked disabled while retaining their connected state.
- Switching provider account uses the current active Codex profile's CODEX_HOME; selecting a different Codex profile remains via the existing global Accounts card.
- If the UI is served by an older already-running launcher whose `/api/connectors` response lacks `enabled`, hide the new controls and show a restart hint instead of sending unsupported requests.

## Ownership and acceptance
- Backend/runtime worker: `src/connector-preferences.js`, `src/connector-status.js`, `src/launcher-app.js`, `src/server.js`, `src/codex-app-server.js`, and corresponding backend tests.
- UI worker: `launcher-ui/app.js`, `launcher-ui/styles.css`, and new focused connector UI tests.
- Focused backend/UI tests pass; disabled connector is denied before provider/model turn setup; no tests contact real providers; scoped diff check passes.
