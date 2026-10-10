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

## Open for the detailed design

- Where profile metadata lives (launcher state) and how the active profile reaches
  project servers that are already running.
- Behavior when a profile's tokens expire (re-login prompt in the UI).
- Owner note: confirm the plan terms allow alternating accounts; the feature only
  automates what is done by hand today.
