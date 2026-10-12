# ADR: Owner opt-in per-run scratch directory for sandboxed acceptance checks

Status: accepted 2026-10-12 (owner decision `change_environment` on lead
request `a125b4c6-f640-45ae-a106-22f97837f8e9:h1`). Implemented in
`src/acceptance-scratch.js`, `src/project-settings.js` and their callers;
reviewed (Opus, APPROVE; the symlinked-base finding was fixed before rollout).
Contract note: `docs/execution-boundary-contract.md`.

## Context

Agent-proposed acceptance checks run in the App Server sandbox
(`AGENT_CHECK_SANDBOX_POLICY`): cwd read-only, no network, `writableRoots: []`,
only /tmp writable. The `codex_team_work` regression suite (AC20/AC21) needs a
writable scratch root outside the checkout, /tmp, the effective TMPDIR and
$HOME (`artifacts/m4/regression-scratch/README.md` in that project), so a
mandatory M4 check could not pass in that sandbox.

## Decision

- Opt-in per project by the owner only: `acceptanceScratch: { env, baseDir }`
  in `.runtime/projects/<id>/project-settings.json`, read at server start. The
  lead agent cannot enable it; pinned checks and their schema are unchanged.
- Each acceptance run creates a fresh `<baseDir>/run-*` directory (mode 0700)
  with sibling subdirectories `tmp/` (TMPDIR) and `scratch/` (each configured
  variable, here `TEAMWORK_TEST_SCRATCH_ROOT`).
- Sandbox when enabled: the run directory is the only writable root; /tmp and
  TMPDIR excluded; network disabled; cwd not writable. Env is passed through
  `command/exec` `env`; reserved names and prefixes are refused.
- `baseDir` must be absolute, a real directory (no symlink at it or in any
  ancestor), owned by the user, not group/other-writable, and outside the
  workspace and temp roots. For `codex_team_work` it is
  `/var/tmp/cp-acceptance-scratch`, because the fixture rejects anything under
  /home.
- The run directory is removed on pass, fail, timeout, cancel and error. A
  cleanup failure is an advisory `scratch_cleanup_failed` issue and never
  changes the disposition; a provisioning failure is `acceptance_error`, never
  a run without scratch.
- Disabled (default): the exec request and policy are unchanged.

## Alternatives considered

- Make /tmp-based scratch acceptable to the tests: rejected; the fixture
  contract requires excluding /tmp and TMPDIR.
- Let the lead propose the scratch in its checks: rejected; it would let the
  agent widen its own sandbox.
- Global writable root for all projects: rejected; changes every project's
  sandbox.
- Substitute evidence from another environment or deferring the requirement:
  rejected by the owner; both leave M4 pending.

## Consequences

- Settings change only on server restart.
- No sweep of stale `run-*` directories after a crash; they stay inside the
  owner's 0700 base (disk only).
- `command/exec` has no cancel here: after a cancel the abandoned process may
  outlive the run and the directory is removed under it, recorded as a cleanup
  issue, never a pass.
- `/var/tmp` is world-writable; safety relies on the base ownership, mode and
  real-path checks.
