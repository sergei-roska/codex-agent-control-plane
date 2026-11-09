# Review: concurrent startup replay

Read /home/sr/codex-home/agents/critic.toml developer_instructions before work. Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Review worker changes only against .agents/teamwork/concurrent-startup-20261030/evidence/baseline; many implementation files are untracked, so git diff alone will omit them. Do not review the whole inherited dirty tree.

Objective: fix launcher-managed concurrent-v1 startup failure after active provider account changes, without weakening unknown-effect fences or losing task history/owner controls. Root independently observed concurrent_startup_recovery_unsafe: delivery_role_recovery_proof_unavailable from launcher8081 status. Worker traced mismatch between current provider account/home and historical fully proven/settled terminal failures in persisted provider_closing phase. See brief.md and worker handoff.md.

Review exact persisted identity, attempt state, released claim, executor settlement, provider pin, settings digest, terminal shutdown digest, cleanup receipt, process-group proof, no-publication evidence. Terminal settled replay must be idempotent under current account drift, while active/unproven/unknown records still enforce current provider/settings checks. Tampered terminal proofs must refuse replay. Both old terminal attempts and latest undispatched review must safely settle without resuming tasks.

No live services or live DB mutations. Live DB may be read-only inspected. Disposable test services/data allowed. Reports only under concurrent-startup-20261030/review/. Run decisive focused positive/negative tests, reuse valid evidence. Root independently passed large-review (1) and undispatched-review (3) in current inherited code before worker changes; logs evidence/*.tap. New source changes invalidate affected inputs as appropriate.

Return APPROVE/REJECT/INCONCLUSIVE with exact evidence, source lines, and required fix only. Do not claim full delivery acceptance; this milestone is server startup. Root owns live start after approval.
