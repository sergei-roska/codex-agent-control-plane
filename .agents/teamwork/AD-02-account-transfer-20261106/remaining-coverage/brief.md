# AD-02 remaining account-transfer coverage

## Goal

Complete deterministic legacy-path coverage for the still-open AD-02 cases:
owner re-login after all configured profiles require authentication, and account
failover while a worker attempt has an uncertain live effect. Preserve the same
objective and pinned check. Do not submit new-account writes until the A attempt
is safely reconciled. Keep raw account IDs, credentials, and profile-home paths
out of durable provider-call evidence.

## Verified context

- The focused settled read-only A-to-B transfer is approved; see the parent
  `handoff.md` and `review/handoff.md`.
- The backlog names owner re-login and an unsettled live attempt as remaining
  AD-02 scenarios.
- Source context: `src/account-profiles.js`, `src/budget-watcher.js`,
  `src/lead-orchestrator.js`, `src/session-threads.js`, and the existing
  `test/account-failover-context.test.js`.
- Worktree baseline is the shared checkout at current HEAD `ab5c195` plus
  existing uncommitted changes. Preserve all changes; do not stage or commit.

## Ownership and boundaries

Own this directory and the allowed paths below. Do not edit another task's
handoff or project-level status. Production changes are allowed only when a new
test demonstrates a defect in the covered behavior.

Allowed paths: `src/account-profiles.js`, `src/budget-watcher.js`,
`src/lead-orchestrator.js`, `src/session-threads.js`,
`test/account-failover-context.test.js`, `test/budget-watcher.test.js`, and
`test/e2e.test.js` if needed for focused composition.

No live provider, real account, quota use, credential access, runtime
activation, external messages, Git staging, or commits.

## Acceptance

1. A deterministic fixture proves all profiles requiring authentication becomes
   a specific, recoverable authentication wait, not a generic failure or owner
   request to paste credentials.
2. After the configured login-state signal changes, the same objective resumes
   automatically without a new submission and retains its original check and
   workspace scope.
3. An unsettled A attempt is reconciled by stable attempt identity before any
   B writer call. Unknown stays held; no duplicate dispatch or workspace effect
   is manufactured. If proof says the effect settled, retain it exactly once.
4. Account-specific threads are not reused across profile homes; durable binding
   contains only one-way account hashes.
5. Add focused regression assertions and report exact commands and outcomes.

## Report

Update `handoff.md` with changed paths, evidence, commands/results, and remaining
limits. Do not expand claims to live providers or behavior not exercised.
