# Several Codex accounts with automatic switching (ACC-01)

Status: owner-approved direction, 2026-10-10. Queued after PW-3, together with BUD-2.

## Owner requirement

The owner works with two Codex accounts and today re-logs in a terminal when one
account's usage limit is exhausted. The web interface should manage both accounts,
and the orchestrator should switch to an account that still has budget by itself.

## Decisions

1. One profile per account: its own `CODEX_HOME` under
   `~/.codex-a2a/accounts/<name>/` holding that account's `auth.json`. `config.toml`,
   `AGENTS.md`, `hooks.json`, and `hooks/` are symlinks to the owner's `~/.codex`, so
   settings stay shared and each profile refreshes only its own tokens (refresh-token
   rotation is safe). The owner's terminal `codex` and `~/.codex/auth.json` are not
   touched.
2. Login from the web UI through the App Server (`account/login/start`, then
   `account/login/completed`) using a short-lived App Server started with the new
   profile's `CODEX_HOME`. Logout and removal through `account/logout` and deleting
   the profile directory.
3. Active account is launcher-wide; each project server spawns its App Server with
   the active profile's `CODEX_HOME`. Switching restarts the App Server generation
   only when no turn is running (paused run or between rounds); otherwise it waits
   for the next idle point.
4. The limits card lists every profile (email, plan, 5h and weekly remaining, active
   marker) with Switch and Add account. Limits of inactive profiles are read with a
   short-lived App Server per profile and cached for 5 minutes.
5. Automatic switching, behind a toggle: when a run pauses for budget (BUD-1), the
   watcher checks the other profiles with the same availability rule
   (`ordinaryUsageAllowed` and no reached bucket for the team's models); if one is
   available, it switches to it and resumes the run at once. If none is, it waits
   for the earliest reset on any profile.
6. Codex threads live in `CODEX_HOME/sessions`. For BUD-2 continuation across a
   switch, the profiles share one sessions directory; this must be verified with a
   live thread resume before continuation relies on it. Until verified, a switch
   continues with a fresh thread (re-plan) instead of resuming.

## Detailed design (2026-10-10)

Profiles store, shared by the launcher and project servers: `src/account-profiles.js`
over `CODEX_A2A_ACCOUNTS_DIR` (default `~/.codex-a2a/accounts`).

- `profiles.json`: `{ version: 1, active: <name>|null, autoSwitch: boolean,
  profiles: [{ name, home, email, planType, addedAt }] }`, written atomically
  (temp file + rename). No file or no profiles means today's behavior: the default
  `CODEX_HOME`.
- Profile home `<accountsDir>/<name>/`: its own `auth.json` and Codex state; symlinks
  to the owner's `~/.codex` for `config.toml`, `AGENTS.md`, `hooks.json`, `hooks/`,
  `rules/` (only those that exist). Sessions and thread state stay per profile;
  BUD-2 resumes a thread only on the profile that created it.
- Names: `[a-z0-9-]{1,32}`.

App Server home switching without touching the supervisor:

- `CodexAppServer` accepts `codexHome`; when set, the spawn env gets
  `CODEX_HOME=<home>`. Nothing else in the supervisor changes.
- New `src/app-server-switch.js`: a forwarding wrapper with the `CodexAppServer`
  surface used by the server (run, readRateLimits, getAccount, execCommand,
  getVersion, close, supervisor/status calls). It counts in-flight `run` calls. Before
  each new `run` and on request, if the profiles store's active home differs from the
  current one and nothing is in flight, it closes the current instance and creates a
  new one for the active home. `switchTo(name)` returns `switched`, `already_active`,
  or `busy` (never interrupts a running turn). The lane confinement probe is keyed by
  App Server version and is unaffected.
- The server uses the wrapper everywhere it used the App Server.

Automatic switching (server side, in the BUD-1 watcher, when `autoSwitch` is on):
when a run is paused for budget and the active profile is not available, check the
other profiles with the same availability rule through a short-lived App Server per
profile; if one is available, set it active in the store, switch the wrapper (idle,
since the run is paused), and resume the run at once. Otherwise keep waiting and also
schedule a check at the earliest reported reset of any profile.

Launcher and UI:

- Launcher API: `GET /api/accounts` (profiles with email, plan, 5h and weekly
  remaining, active flag, autoSwitch; limits read with a short-lived App Server per
  profile, cached 30 s), `POST /api/accounts` `{ name }` starts login and returns
  `{ loginId, authUrl }`, `GET /api/accounts/login/:loginId` reports `pending |
  completed | failed`, `POST /api/accounts/:name/activate`,
  `POST /api/accounts/auto-switch` `{ enabled }`, `DELETE /api/accounts/:name`
  (logout, then remove the profile dir; refused for the active profile while a run
  is working). Login keeps a short-lived App Server with the new home alive until
  `account/login/completed` or 10 minutes.
- `GET /api/limits` keeps working for the active profile.
- Limits card: one block per profile (email, plan, remaining bars as today, reset
  times, an active marker), buttons Activate, Remove, Add account (inline name field,
  then an "Open login page" link and a waiting state), and an Auto-switch toggle.
  In-page UI only, no native dialogs.

Tasks: ACC-1 profiles store, `codexHome`, wrapper, server wiring; then in parallel
ACC-2 launcher API and UI, ACC-3 automatic switching in the watcher.

## Open for the detailed design

- Where profile metadata lives (launcher state) and how the active profile reaches
  project servers that are already running.
- Behavior when a profile's tokens expire (re-login prompt in the UI).
- Owner note: confirm the plan terms allow alternating accounts; the feature only
  automates what is done by hand today.
