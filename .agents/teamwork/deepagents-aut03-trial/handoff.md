# Handoff: isolated DeepAgents Explorer prototype and AUT-03 trial

Status: AUT-03 opt-in is committed as 79290f0 and b664180. Paired skill-off/on
planning completed. The skill-on plan is more specific about tool/token limits
and failure coverage in this single pair, and keeps the same integration seam.
No files changed in either planning task. The project setting was removed and
the server restarted, so AUT-03 is default-off again.

- Baseline commit: dd3607aa9d2f0c791d03ab24718790c186245e6a.
- `main` was clean after commit `dd3607a`.
- Launcher A2A project `f69dd0e80b` is running on port 3002 against the repository.
- Its process has no `CODEX_A2A_AUT03_TRIAL_RUN_IDS` value. The current exact-run
  gate therefore leaves AUT-03 off.
- Per-project owner settings already live at `.runtime/projects/<id>/project-settings.json`
  and are loaded from `CODEX_A2A_PROJECT_SETTINGS` at server startup.
- User authorized a narrow project-level opt-in instead of UUID-only selection.
  Keep it default-off and server-owned; retain the existing UUID allowlist.
- Implementation and exact verification results are recorded in
  `aut03-project-opt-in/handoff.md`.
- Next: commit the reviewed change and restart the project server while its
  owner setting remains absent/off. Freeze the no-skill planning result before
  enabling the setting for the skill-on paired task.
- No runnable DeepAgents prototype was produced. The authorized compatibility
  fallback established that the checked-in Codex App Server client does not
  expose the LangChain model/tool-call exchange required by DeepAgents. An
  offline proof test and two status documents are pending commit.
- Full current suite: 1238 total, 1226 passed, 11 failed, 1 skipped. The clean
  baseline has the same 11 failures and one skip.
