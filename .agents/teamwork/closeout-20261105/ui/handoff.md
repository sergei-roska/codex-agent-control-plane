# UI restoration handoff

Status: running and verified. Launcher and project server should remain available.

The initial isolated launch failed because the configured private `CODEX_HOME` did not exist. Provisioned that directory at `/home/sr/codex-work/harness-ui-runtime-20261104/codex-home` with mode 0700 and copied the existing `auth.json` (0600), `config.toml` (0600), and `installation_id` (0644) into it. No credential values were printed. The original `/home/sr/codex-home` was only read. Replaced the copied private config with the existing owner settings (`approval_policy = "never"`, `default_permissions = ":danger-full-access"`, model `gpt-6.1-sol`, effort `high`) plus the supported exact project trust table for `/home/sr/Projects/Workspace/harness-ready-20261104` with `trust_level = "trusted"`. Restarted only the disposable project server to load it; it remains `status=running`, `readiness=ready`, `taskReady=true`.

Startup logs also report `/home/sr/Projects/Workspace/codex-agent-control-plane/.codex` as untrusted because the private config intentionally trusts only the isolated project workspace. This is the launcher source process context; source `.codex` config/hooks/exec policies are disabled. No model/provider turns were run.

Launcher PID 1301491 listens on 127.0.0.1:8082. Project server PID 1336040 listens on 127.0.0.1:3002. Project `88ae4d8dfe` uses `concurrent-v1`. UI root, CSS, JS, and project agent card returned HTTP 200. Workspace Git status is clean. Full results are in `evidence.json` and adjacent JSON/log captures.

To restart the launcher, run from `/home/sr/Projects/Workspace/codex-agent-control-plane`:

```sh
nohup setsid env -u OPENAI_API_KEY -u CODEX_WORKSPACE -u PORT LAUNCHER_PORT=8082 LAUNCHER_RUNTIME_DIR=/home/sr/codex-work/harness-ui-runtime-20261104 CODEX_HOME=/home/sr/codex-work/harness-ui-runtime-20261104/codex-home CODEX_A2A_ACCOUNTS_DIR=/home/sr/codex-work/harness-ui-runtime-20261104/accounts CODEX_A2A_TOKEN_FILE=/home/sr/codex-work/harness-ui-runtime-20261104/a2a-token node launcher.js >.agents/teamwork/closeout-20261105/ui/launcher.log 2>&1 < /dev/null &
```

To start the registered project after launcher restart:

```sh
curl -fsS -X POST http://127.0.0.1:8082/api/projects/88ae4d8dfe/start -H 'Content-Type: application/json' -d '{}'
```

Verify with `curl -fsS http://127.0.0.1:8082/api/projects/88ae4d8dfe/status`; the expected fields are `status=running`, `readiness=ready`, and `taskReady=true`. Do not replace the private runtime credentials with global-home files on later restarts.
