# CN14 host map handoff

Status: complete, read-only. 2026-10-27.

## Completed

- Wrote `brief.md` with source-backed composition, identity, facade/control, launcher proxy/UI, shutdown/drain and disposable fixture seams, plus unresolved account/provider contract facts.
- Read required explorer and development-access instructions, current `.agents/teamwork/PROJECT.md`, prior engine integration handoff, server/launcher/settings/router code, and ignored engine prototype.
- Confirmed disposable host fixture at `test/server.test.js`: `startServer({listen:false, appServer: fake, stateFile/temp workspace, projectSettingsFile})`. Launcher injection tests are `test/launcher-startup.test.js`, `test/launcher-app.test.js`, and `test/launcher-projects.test.js`.

## Constraints / next action

- No product, test, tracked doc, Git, service, account, or target changes made. Only this requested ignored scratch package was written.
- Current project settings parser accepts `deliveryEngine`, but `startServer` does not consume it. Current startServer has no projectId parameter; launcher has stable ID and passes settings/state paths, not project ID.
- Review `brief.md` before assigning host/UI implementation. Account ID property and exact core facade compatibility remain facts for the implementation worker to establish against its restored source.
