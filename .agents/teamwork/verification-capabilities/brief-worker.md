# A2 local verification preflight and owner decision continuity

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Baseline2a9f65a clean.
Read /home/sr/codex-home/agents/worker.toml developer_instructions, AGENTS.md,
this task's handoff.md, docs/harness-autonomy-audit-2026-10-21.md A2.
Node CommonJS, npm test. Root owns Git/coordination; you own scoped source/tests/docs.
No other source writer. Do not commit, start launcher/live project services,
resume real tasks, edit target projects, call real models, trigger external CI,
install dependencies or send external messages. Disposable fake-provider test
stacks allowed. English/ASCII artifacts, task handoff under this directory.

Scope decision: support existing LOCAL verification routes. ownerChecks already
persists owner authorization in owner-edited project settings; source=agent
already controls sandbox execution. Reuse those contracts and HAR-03 policy.
No new general authorization system or external runner is warranted by the code.
External CI execution remains an explicitly unsupported route, not fabricated.

Implement these cohesive changes:
1. A bounded command-free verification preflight exposed to Lead before work.
   Build a small module inspecting the current pinned acceptance contract,
   local execution route and existing resolved execution policy. For owner
   commands, inspect argv[0] executable availability by safe filesystem/PATH
   lookup without executing any workspace script/binary, shell, package manager,
   capability probe or model. For agent checks inspect execCommand capability
   and resolved native/strict policy; no source=agent to host fallback.
   Distinguish known unavailable, observed available interface/executable, and
   unverified dependencies/environment. Policy/API availability never proves
   socket binding, toolchain dependencies, CI access or passing tests.
   Use an explicit scope/status so ready is never misread as complete evidence.
   Stable bounded local route identity should encode project/policy/check argv
   scope, excluding candidate content: route authorization survives candidate
   changes, test/review receipts do not. Do not persist PATH/secrets/raw config.
   Thread projection through real server/orchestrator/graph full+delta prompts
   and checkpoint/run digest as appropriate. Refresh cheap executable checks
   after candidate changes, on resume/restart or before planning so repaired
   dependencies do not remain permanently marked unavailable. Bounded lookup,
   no repeated expensive native policy reads when unchanged. Existing injected
   app servers/tests lacking policy APIs must report unknown honestly.
   An unavailable local executable is work for internal environment repair;
   do not introduce a new owner pause or bypass writer/review gates. Prompt
   instructs qualify/fix route before substantial implementation and reuse
   existing configured checks/policy without asking permission again within
   scope. Actual auth/spending/external writes still require owner decisions.
2. Retain owner answer CONTEXT, not just opaque choice and answer. Store bounded
   versioned records including decisionId, reason, question, chosen option id
   and description (when exact explicit choice), evidence/related IDs, round,
   answer. Preserve legacy humanAnswers compatibility and special recovery
   grants/defer/check-change behavior. Never infer broader grant from prose or
   recommendation; deferred/outside-run decisions remain blocked.
   Full/delta prompts and bounded run/session/followup digests must carry useful
   context across fresh threads/restarts/followup runs. Prior-run context is
   historical scoped guidance, not automatic authority for changed goals or
   new spending/access/remote writes. Do not automatically resolve owner asks
   by text similarity. Avoid unbounded growth/new prompt blowup.
3. Docs describe exactly what is supported and what remains unverified.
   Register A2 local portion and external-route limitation honestly.

Acceptance/verification:
- Existing ownerChecks reused across changed candidates with same route identity;
  actual acceptance must run freshly and previous receipts cannot pass a new target.
- Command-free preflight negative controls: missing executable, no execCommand,
  unavailable native policy -> strict/unknown; no project command execution.
  No sandbox promotion. Real filesystem lookup handles cwd-relative executables
  and PATH semantics conservatively. Abort/unexpected inspection errors must not
  become success or uncontrolled run failure. Test repaired executable refresh.
- Real graph/server fake-provider integration shows initial/full+delta context,
  resume/restart retention, new candidate fresh evidence, and no owner question
  merely to reuse configured local route. No real provider/model calls.
- Owner decision context survives thread/run digest bounds, and defer/outside_run,
  paid/access/external cases never become automatic grants. Legacy checkpoints work.
- Run meaningful focused suites for touched behavior; do not duplicate root full
  suite. Report exact commands/results, source risks and changed files.

Raise material contract uncertainty early; routine implementation choices yours.
When stable, freeze source for independent critic, then focused challenger probes.
