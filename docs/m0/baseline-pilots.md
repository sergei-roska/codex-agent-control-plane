# M0 baseline and representative pilots

Date: 2026-09-30. This records verification, not live delivery capability.

## Existing suite

| Item | Result |
| --- | --- |
| Command | npm test (node --test test/*.test.js) |
| Successful environment | Approved subprocess/socket-capable test execution |
| Final result | 317 tests, 317 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo |
| Duration | 32974.264834 ms |
| Exit | 0 |
| Node / npm | v24.21.0 / 12.1.0 |
| Installed Codex CLI | 0.159.0 (version inspection only) |
| OS | Linux 7.0.0-34-generic |

Restricted initial execution did not establish a green baseline: subprocesses
were denied with EPERM. A diagnostic `node test/durable-store.test.js` reported
14 cases, 10 passes and 4 failures at lines 234, 290, 312 and 332 involving
spawnSync(node/git). The initial full run was stopped; a focused restricted
acceptance run also failed. These are environment limitations, not asserted
product regressions. The authorized full suite subsequently passed as recorded
above. It uses fake App Server fixtures and temporary repositories, not live
OpenAI, Jira or Confluence. No product/test files were changed to make tests pass.

No pilot repository tests or model runs were performed during M0. Existing suite
success does not verify proposed dashboard endpoints, pairing, nine delivery
roles, lifecycle commands, browser UI or external integrations.

## Protected reference and working copy

- SHA256 manifest: [reference-integrity.sha256.txt](reference-integrity.sha256.txt),
  46 protected files. Manifest digest:
  `5add1afa3b0cddff81b1b4975bc4e531464673d2ee8622d3c74a0d096723dcad`.
- `sha256sum -c docs/m0/reference-integrity.sha256.txt`: all 46 OK.
- `diff -qr artifacts/dashboard web/dashboard`: identical contents at M0.
- Both trees contain 46 regular files, 292149 file-content bytes; no shared
  device/inode pairs and no symlinks. The working copy is independent.
- No build/generator ran against the protected reference. Future application
  changes affect only the working copy; content equality is not required after M1.
  Protected-source manifest equality remains required.

`artifacts/` is ignored by Git, so git diff alone cannot prove reference integrity.
Use the saved manifest after every dashboard implementation increment. This
baseline proves equality since its capture, not an earlier unrecorded history.

## Pilot repositories

Read-only inspection established these real target repositories. Their state is
a dated observation, not authority to switch branches, modify or publish there.

| Pilot | Canonical Git root | Application/check evidence | Observed state |
| --- | --- | --- | --- |
| Primary | /home/sr/Projects/ai-project-orchestrator | Application is nested at ai-project-orchestrator/; tests/README.md:3 specifies python3 -m unittest discover -s tests -t . -p "test_*.py" from application directory | Branch ai/rf-web-layer; three untracked paths, therefore clean-checkout preflight would block mutation |
| Secondary | /home/sr/Projects/Workspace/multi-agents-orchestrator | 59 inspected files include dashboard/evals/telemetry; docs/eval-ops.md:5 requires a supplied executor for live runs; no comparable application suite established | Branch main, clean |

Primary pilot fixtures are synthetic local tasks, not real Jira issue IDs:

| Fixture | Objective / evidence location | Expected validation |
| --- | --- | --- |
| P-01 | Intake classification at app/intake.py:18 and tests/integration/test_ticket_workflow_e2e.py:60 | Direct/Jira-shaped fixture preserves source, routes ready requirements, handles missing context |
| P-02 | Context assembly at app/engine/context_builder.py:21 and tests/unit/engine/test_context_builder.py:31 | Common required skills/context retained; scoped regression evidence |
| P-03 | Protected delivery at tests/unit/test_delivery_workflow.py:136 | Pending/denied/stale decisions cause no protected effects |

These are bounded candidate tasks for direct bug/feature and trust-boundary
pilots. A specific change must first demonstrate an actual defect or define a
requested feature; M0 does not invent bugs from file names. Run them in an
operator-approved clean checkout/isolated test workspace, pin HEAD and expected
outcome, and obey its project instructions. M3 exercises direct workflows; M6
adds operator-provided real Jira feature/bug issue keys and accessible Confluence
pages (U-02). M9 performs bounded live OpenAI pilots and recovery validation.
