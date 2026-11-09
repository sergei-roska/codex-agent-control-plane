# Isolated Harness UI launcher

Status: running and verified; child project server intentionally stopped.

## Owned launcher

Source working directory: `/home/sr/Projects/Workspace/codex-agent-control-plane`.
Source HEAD at startup: `c67bf681e4b20809fe37f9bdbb6a83ef7c2a0990` (the lead's current working-tree changes were loaded from disk).
Launcher URL: `http://127.0.0.1:8082/`.
PID: `2834929`; PGID/SID: `2834929`; process start: `Wed Nov 4 16:53:29 2026` local system time (Europe/Chisinau). PID file: `launcher.pid`. Log: `launcher.log`.

Durable restart command, run from the source working directory:

```sh
nohup setsid env \
  -u OPENAI_API_KEY -u CODEX_WORKSPACE -u PORT \
  LAUNCHER_PORT=8082 \
  LAUNCHER_RUNTIME_DIR=/home/sr/codex-work/harness-ui-runtime-20261104 \
  CODEX_HOME=/home/sr/codex-work/harness-ui-runtime-20261104/codex-home \
  CODEX_A2A_ACCOUNTS_DIR=/home/sr/codex-work/harness-ui-runtime-20261104/accounts \
  CODEX_A2A_TOKEN_FILE=/home/sr/codex-work/harness-ui-runtime-20261104/a2a-token \
  node launcher.js \
  >.agents/teamwork/dccourts-182-trial-20261104/environment/launch-ready/launcher.log 2>&1 < /dev/null &
```

This uses only the new private runtime. No auth token was read or logged; no token exists in this runtime because the child server has not started.

## Registered project

Workspace: `/home/sr/Projects/Workspace/harness-ready-20261104`.
Clean minimal Git repository on branch `main`, commit `5064fdc2970dc33d564a08d9c4aaf5da5833147f`, containing only `README.md`.
Project ID: `88ae4d8dfe`; API-derived display name: `harness-ready-20261104`.
Project port: `3002`; delivery engine: `concurrent-v1`.
Status/readiness: `stopped`; taskReady: false; PID: null. The backend has not been started pending the lead's final native acceptance decision.
Fresh per-project state DB path: `/home/sr/codex-work/harness-ui-runtime-20261104/projects/88ae4d8dfe/state.sqlite`; it does not exist until the project server starts. Registry and project settings are inside the new runtime. Registration used `POST /api/projects`; engine selection used `PUT /api/projects/88ae4d8dfe/delivery-engine`.

Health report: `health-check.json`. UI root, `/ui/styles.css`, and `/ui/app.js` all returned HTTP 200. API listed exactly this one project, stopped, with `concurrent-v1` selected.

## Preserved listeners

Existing launcher PID `422373` remains bound to `127.0.0.1:8081`, start time `Wed Nov 4 09:58:02 2026`; it was not signaled or changed. Unknown listener on port `3000` remains untouched. Port `3001` was briefly reserved by this worker during API registration so the normal allocator skipped it and selected free port `3002`; the reservation is closed. The new launcher is the only owned listener on port `8082`. No project listener is bound to port `3002` while the project is stopped.
