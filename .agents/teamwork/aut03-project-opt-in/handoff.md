# Handoff: AUT-03 per-project owner opt-in

Status: project-scoped opt-in is committed in 79290f0 and b664180. The setting
is sufficient for an isolated project; a non-empty UUID list optionally narrows
run IDs. Paired skill-off/on planning completed. The runtime setting is removed
and the server restarted with the feature default-off.

## Baseline and project

- Baseline: clean `main` at dd3607aa9d2f0c791d03ab24718790c186245e6a.
- Active A2A project: f69dd0e80b, port 3002.
- `.runtime/projects/f69dd0e80b/project-settings.json` is absent, so the new
  setting resolves to default false. The project server restarted at PID 154487.

## Implementation

- `aut03LeadSkillEnabled` is a strict boolean in the existing settings schema,
  defaults false, and is loaded once at server startup.
- AUT-03 requires the project owner setting. A non-empty exact UUID list is an
  optional narrowing filter; empty list supports server-generated task IDs.
- Request metadata and assignment fields do not grant authority.
- Checkpoint context rejects activation drift; existing skill pin, hash,
  Lead-only delivery, and session/profile separation remain in place.
- Relevant AUT-03 docs and an authority ADR are updated.

## Verification evidence

- `node --test test/project-settings.test.js test/lead-graph.test.js`: 247
  passed, 0 failed.
- The selected AUT-03 startup setting test in `test/server.test.js`: 1 passed.
- The selected role-card and worker isolation test in
  `test/a2a-role-service.test.js`: 1 passed.
- Final current `npm test`: 1237 total, 1225 passed, 11 failed, 1 skipped, 0
  canceled, 71722 ms.
- Clean baseline `npm test` at dd3607a: 1231 total, 1219 passed, the same 11
  test failures, 1 skipped, 0 canceled, 68414 ms. The change adds five passing
  tests with the first implementation; the follow-up adds a sixth passing test.
  Neither commit introduces additional full-suite failures.
- The repeated baseline failure titles are in A2A continuation, Codex App
  Server tool configuration, contracts, role catalog, and writer lane tests.
- `git diff --check` passes.

## AUT-03 paired planning

- Skill-off task: `00a038f7-9914-41de-909c-a74a65939f18`.
- Skill-on task: `886ab2ca-6e98-45e2-b76a-5cfb9a82fd3c`.
- Prompt was identical; both tasks were fresh and planning-only, with no worker
  dispatches or file changes.
- The skill-on checkpoint recorded the AUT-03 pin. Its plan kept the same
  integration seam and proposed tighter tool/token budgets plus broader failure
  cases. This single pair is descriptive, not a general quality result.

## Final state

The offline compatibility proof and status docs were committed in `ebe51c8`.
AUT-03 remains default-off after the paired trial.

No runnable DeepAgents execution or implementation was performed. A2A plan and
compatibility tasks were canceled after their workers finished but parent
states remained working. The skill-on plan checkpoint confirms the pinned
AUT-03 skill was used. Temporary evidence: `/tmp/aut03-deepagents-skill-off-plan.txt`,
`/tmp/aut03-deepagents-skill-on-plan.txt`, `/tmp/deepagents-explorer-final-npm-test.log`,
and `/tmp/aut03-baseline-npm-test.log`; they may disappear.
