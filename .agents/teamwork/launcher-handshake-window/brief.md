# Handshake starts account usage window

## Goal
Fix the account handshake button so a click performs one minimal model turn
using that exact existing ChatGPT account, then refreshes its limit countdown
from provider data. Current implementation merely reads limits and the UI
ignores the response, so it cannot start an idle usage window.

## Ownership and context
Repository: /home/sr/Projects/Workspace/codex-agent-control-plane.
Preserve all dirty changes (README.md, launcher.js, src/launcher-app.js,
launcher-ui/app.js, launcher-ui/styles.css, test/launcher-startup.test.js).
Read /home/sr/codex-home/agents/worker.toml developer_instructions before work;
follow /home/sr/codex-home/lead-policy.md and development-access.md.
Worker owns src/launcher-app.js, src/codex-app-server.js, launcher-ui/app.js,
launcher-ui/styles.css if necessary, relevant focused tests, and worker handoff.
Root owns PROJECT.md, scope, acceptance and all Git operations. No commit.

## Verified entry points
- launcher-ui/app.js:1512-1540 sends POST .../handshake and only shows Connected.
- src/launcher-app.js:638-665 readLimits/cachedLimits; :724-742 handshake route
  selects system null home or named profile home then forces only a limit read.
- src/codex-app-server.js:567 getAccount, :789 readRateLimits, :798 run,
  :497 initialization, :1179 close, :592 onNotification. Existing run has
  extensive project/tool policies; avoid invasive changes to ordinary turns.
- test/launcher-accounts.test.js has injected FakeAppServer and HTTP fixtures.
- test/codex-app-server.test.js has FakeProcess/fakeSpawn protocol tests.
- Node CommonJS, node --test targeted files; installed dependencies available.
- Official App Server lifecycle docs fetched at
  https://learn.chatgpt.com/docs/app-server: thread/start plus turn/start starts
  generation; turn/completed reports terminal status; rate-limit resetsAt is
  Unix seconds. Validate new protocol/config fields against the installed
  codex schema (generate schemas to an owned temp directory, no model call).
- Existing normal shared-quota model is gpt-6.1-sol; use low effort for the
  minimal handshake. Do not select Astra or a different quota bucket.

## Acceptance and boundaries
- One short request (e.g. reply OK) on the clicked account, independent of which
  account is active. No switch, login, API key, target/project task changes.
- Dedicated disposable/ephemeral thread and isolated scratch cwd; minimal
  context, no tools/actions/files intended; enforce existing read-only/no-network
  execution boundaries and disable tool integrations through supported settings.
  Prefer small dedicated method over changing ordinary run lifecycle globally.
- Bound startup/turn wait, handle completion races, failed/interrupted turns,
  process errors/timeouts and cleanup. Never report success before real completed
  generation; no automatic replay after uncertain dispatch.
- Keep repeat concurrent clicks for one account from producing duplicate turns;
  other accounts stay independent.
- Read fresh limits after generation (brief bounded retries only if provider
  update lags). Return actual primary/secondary/identity data, update selected
  card immediately and maintain countdown from actual resetsAt. Never invent
  now+5h or reset an existing window locally. Missing reset information must be
  explicitly pending/unconfirmed, not a false Window started label.
- Keep UI status meaningful after card refresh. Preserve unrelated card edits,
  avoid replacing in-flight account state with overlapping refreshes.
- Focused regression tests using fake servers/processes for turn-before-limits,
  correct account, cleanup, failure/no fake reset, concurrent dedup and UI refresh
  as practical. Run relevant node --test suites and syntax/diff checks.
- No live model/provider turn, launcher/project restart, deployment or commit.
  Checking native schemas is allowed; existing ChatGPT subscription auth is the
  configured path, no OpenAI API key or credential inspection is needed.

## Report
Write concise handoff.md in .agents/teamwork/launcher-handshake-window with
changes, decisions, exact verification/results, limits and next action. Add
brief-worker.md if useful. Share decisive findings and Status complete/partial.
