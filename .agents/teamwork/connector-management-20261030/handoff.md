# Handoff: Connector management

Status: implemented and locally verified; not loaded into the already running launcher.

## Changes
- Added persistent per-connector enabled/disabled preferences in `connector-preferences.json` under the shared account profiles directory, written atomically with mode 0600.
- The launcher API returns enabled state, supports reversible enablement, and switches a connector's service account by locally clearing only that connector's OAuth grant in the active Codex home and starting OAuth again.
- `codex mcp logout` is called with argv, `shell: false`, the selected connector's validated URL/enabled config overrides, and active `CODEX_HOME`. This removes local credentials only; it does not revoke provider-side access.
- App Server rejects disabled connector selections before permission/model lookup and checks again before turn setup, including on loaded threads. In-flight turns are not interrupted.
- UI adds Enable/Disable, Connected/Disabled state, inline Switch account confirmation, popup-safe OAuth flow, stale-request/status guards, and a legacy-API guard that asks for launcher restart instead of sending unsupported requests.

## Verification
- `node --test test/connector-preferences.test.js test/connector-status.test.js test/launcher-app.test.js test/codex-app-server.test.js test/launcher-connectors-ui.test.js test/launcher-role-page.test.js test/launcher-handshake-ui.test.js`: 237 passed, 0 failed.
- Syntax checks passed for changed JavaScript.
- Scoped `git diff --check` passed.
- Critic: final PASS. Challenger: final PASS (five adversarial probes plus the backend race re-probes). Auditor: connector integrity checks PASS, but aggregate worktree verdict FAIL because unrelated pre-existing changes remain mixed in the worktree; no connector-specific integrity defect was reported.
- All logout and OAuth tests use mocks. No real credentials were read/deleted and no provider flow was started.

## Runtime / workspace notes
- Launcher was not restarted; its currently running process does not yet serve the new API routes. The new UI detects that older API and shows a restart hint instead of exposing unsupported management buttons. The user must authorize a restart before the feature is active in the live panel.
- Existing unrelated working-tree changes and `:memory:.lockdb` were preserved. No commit was made.

## Next action
User-authorized launcher restart is required to load the new backend routes. Do not restart automatically.
