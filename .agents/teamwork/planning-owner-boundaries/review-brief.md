# A3/A4 independent review

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Baseline576fbdf.
Read /home/sr/codex-home/agents/critic.toml developer_instructions, AGENTS.md,
this task's brief-worker.md and worker handoff before review. No product edits.
Disposable fake-provider/SQLite tests only; no live app/model/CI/target actions.
Source frozen for review. Root owns full suite/Git.

Verify bounded state machine, not only expected text:
- two correction reminders + exactly one fresh planning context; final invalid
  output yields partial, never invalid dispatch or an owner loop question;
- fresh context actually overrides session reuse and retains exact violations,
  review six-field contexts, A2 owner decisions, profile/model identity;
- automatic transient/budget resume never resets validation allowance; quota
  error return and model throw both preserve a pending fresh planning attempt;
- checkpoint/restart continuity, explicit owner pause/cancel and legacy owner
  escalation resume, round caps, unresolved writers preserved;
- repeated investigated false finish cannot trigger implicit owner input, while
  missing investigation is rejected and typed genuine owner questions still park;
- synthetic partial ledger + single final acceptance cannot mark stale/unknown/
  failed or owner-blocked checkpoints accepted, cannot authorize new writes or
  weaken changed-check PRD gates, and does not re-enter automatic repair loops.
Review actual code and tests, return APPROVE/REJECT/INCONCLUSIVE with precise
repros/evidence/limitations in review.md. Prior full baseline1412total1403pass
8knownfail1skip; names under verification-capabilities/accepted-comparison.json.
