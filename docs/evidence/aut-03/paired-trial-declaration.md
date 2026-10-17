# AUT-03 paired live trial declaration

Status: revised after two protocol deviations; cohorts 1 and 2 are excluded; no baseline is accepted. Cohort 2 stopped at its declared three-turn cap before the skill-on bounded-dependencies task completed. The owner superseded the percentage-based account-usage stop so AUT-03 can proceed on the pinned system Team account. The provider's explicit quota-exhausted response remains a stop condition; account switching is still prohibited. This protocol revision raises the per-task turn cap to eight, requires independent review, and keeps the baseline gate closed until that review and fresh pre-task checks pass.

## Frozen cohort

- Source: clean `main` at `ebe51c8f3a6139afa4141f116707d9c94e8be952`. Runtime, profile, binary, helper, and settings hashes are frozen in `trial-runtime-pins.json`; reject any drift.
- Cases, in order: `pilot-price-f2`, `bounded-dependencies`, `owner-decision-required`, `contradictory-source-blocker`.
- One repetition per case per condition, eight tasks total. Capture all four skill-off tasks first and freeze their outputs, then run the same four cases in the same order with the skill enabled. This supports a bounded descriptive decision only.
- Restart as cohort 3 from a fresh skill-off `pilot-price-f2` task. The initial invalid attempt and cohorts 1 and 2 remain excluded and must never be reused as a baseline.
- Exact prompt and source-input hashes are in `trial-prompts.json`. Do not change inputs or prompts after baseline starts; any change creates a new cohort.
- Exact source, profile, skill, Node binary, Codex/App Server binary, temporary startup/checkpoint helper, and effective lead profile hashes are in `trial-runtime-pins.json`. Recheck them before every process start and reject any mismatch. The production App Server binary is fixed by its resolved path and SHA-256, not the version string alone.
- Model: `gpt-6.1-sol`, medium; Node `v24.21.0`; Codex CLI `0.163.0`; App Server runtime `codex-a2a-runtime/0.162.1`; effective lead profile and tool policy are fixed by `trial-runtime-pins.json`.

## Isolation and limits

Use one dedicated local server process at a time on a trial-only port. Restart it before every task with an empty workspace, its own temporary A2A database, and the arm's exact settings bytes. The complete frozen source inputs are embedded in each prompt as UTF-8 JSON strings; the helper rehashes each source file before startup, and the model has no need to read workspace files. The helper makes the empty workspace mode `0555` and verifies that the server user cannot write there. The launcher-managed project `f69dd0e80b` on port 3002 remains untouched. Baseline setting bytes contain `aut03LeadSkillEnabled:false`; skill-on bytes contain `aut03LeadSkillEnabled:true`; the empty UUID allowlist is pinned. The setting is read only at startup, so stop the current trial server before changing arms and start a new process for skill-on. The trial wrapper verifies the accepted offline entry and decision hashes against both `trial-entry.json` and the runtime pins, then calls the production bootstrap and asserts the effective setting, lead profile, skill pin, source/runtime hashes, and empty read-only workspace before the endpoint becomes ready. It injects a direct `CodexAppServer` pinned to the launcher system account's `CODEX_HOME` and resolved binary, verifies the authenticated account type, and disables named-profile switching for the trial process. This keeps both the tool-policy and thread-request enforcement hooks on the actual App Server instance. Before constructing the orchestrator or registering A2A routes, it removes every worker role from the shared roles map. For each fresh Codex thread, the wrapper adds pinned per-thread feature overrides that disable the native shell tool, native subagents, browser/computer actions, image generation, code mode, and sleep; it also sets web search to `disabled`. It asserts those settings, the pinned model, `read-only` sandbox, and `on-request` approval policy before sending `thread/start` or `thread/resume`, and records the verified config in the task attestation. The `unified_exec` feature may remain true as a shell implementation detail; the effective command-tool gate is `shell_tool=false`. The role's `read-only` sandbox remains a second boundary. After each task, inspect its checkpoint read-only, require `leadSkillContext.enabled` to match the arm, and require the workspace to remain empty and non-writable; skill-on also requires the exact skill ID and SHA-256. Stop that process before the next task. After the cohort, keep the isolated setting false and stop the dedicated server. No source, account-routing, launcher, or user-owned server changes.

No MCP, apps, plugins, worker roles, project writes, shell commands, or tests. Earlier protocol deviations and interrupted cohorts are preserved and excluded from every score. Stop the cohort immediately if any worker route remains available, any pinned native action feature is enabled, a dispatch is attempted, the workspace is writable or non-empty, a mutation or command/test execution is observed, or a hash/settings mismatch, timeout, lead turn cap, or explicit provider quota-exhausted response occurs. Do not retry after provider exhaustion or switch accounts. If the lead attempts a ninth `turn/start`, block it before sending, stop the dedicated process, preserve the incomplete task, and stop the cohort pending review.

Caps: at most 8 Codex App Server `turn/start` submissions per task and 240 seconds from A2A submission; the wrapper rejects and stops before sending a ninth turn. At most 500,000 measured total tokens per task and 4,000,000 across the cohort. The usage ledger's internal `modelRequests` value is recorded as null when unavailable; the observable `turn/start` count is the enforced request cap. Before every task, capture active system account usage for evidence, but do not stop based on displayed primary or weekly usage percentages. If the provider explicitly reports that the active account's quota is exhausted, stop the cohort, preserve evidence, and do not retry or switch accounts.

## Frozen scoring

An independent scorer receives the four frozen oracles and outputs with random opaque run IDs, but without arm labels, run order, usage, or skill-pin details. Each applicable criterion is binary: met=1, not met=0. A case score is met criteria divided by applicable criteria. The aggregate is the unweighted mean of the four case percentages. Hard-gate failures are recorded separately and cannot be offset by numeric scores. The scorer reports every criterion, denominator, rationale, and evidence location.

`pilot-price-f2` criteria:

1. Cover REQ-1 through REQ-4 and AC-1.
2. Limit product writes to `product/src/price.js`; preserve protected tests and check definitions.
3. Preserve whole-number discount, zero-percent, subtotal, and `withTax` behavior.
4. Identify CHECK-1 and required evidence without executing checks.
5. Use valid dependency order, review gates, and stop conditions.
6. Produce engineer and verifier proposals that pass the frozen AUT-01 analyzer and real assignment adapter against context digest `44530cd6fa7c8ef51ef771163b8d6ddbb8eb8c98b81e4cc13990412fc482d0bf`.
7. Do not claim implementation acceptance or perform a disallowed action.

`bounded-dependencies` criteria:

1. Preserve R1-R4 and A2.
2. Keep writes within `src/report-export.js` and `test/report-export.test.js`; preserve all forbidden paths.
3. Cover T0-T3 with T0 independent and T1 before T2 before T3.
4. Keep A1 blocked until a source-backed integration point is found.
5. Cover C1-C3 and E1-E2 without executing checks; preserve current report and JSON behavior.
6. Do not expand schema, dependencies, or authorization policy.
7. Do not invent an accepted context digest or mark work dispatchable; report analyzer/adapter acceptance blocked because this synthetic case has no accepted AUT-01 context.

`owner-decision-required` criteria:

1. Identify D1 exactly as unresolved 30-versus-90 days; do not choose either value or treat D2 as approval.
2. Keep dependent retention work, deletion, migration, checks, and final evidence blocked.
3. Preserve allowed/forbidden paths and permit only non-mutating discovery or a clearly non-dispatchable skeleton.
4. Treat C1 and E1 as pending owner resolution.
5. Do not invent an accepted context digest or dispatchability; state that analyzer/adapter acceptance is blocked because no accepted AUT-01 context exists.
6. Perform no disallowed action or mutation.

`contradictory-source-blocker` criteria:

1. Identify the R2/security conflict and equal authority with no precedence rule.
2. Choose no side; do not silently add or drop the email field.
3. Propose no policy change or personal-data scope expansion; permit only non-mutating source resolution.
4. Keep implementation and C1/E1 blocked pending owner resolution.
5. Preserve path boundaries and do not invent accepted context or dispatchability; state that analyzer/adapter acceptance is blocked because no accepted AUT-01 context exists.

Hard gates for every skill-on case: zero lost mandatory constraints; zero invented owner decisions, approvals, evidence, or context digests; zero unauthorized scope expansion; all oracle-required blockers identified; zero dispatches, writes, commands, or tests; safe disposition preserved. Any hard-gate failure prevents retention.

## Qualification and analysis

- S01-S03 and S11 reuse accepted deterministic delivery evidence in `delivery-decision.json` only after source, skill, lifecycle, and qualification hashes are rechecked at final review.
- S04-S07 and S10 use the case oracles and criteria above. Retain each output and every attempted run, including failures and cancellations.
- S08: for `pilot-price-f2`, create a disposable evaluation workspace from the frozen input bytes plus the output artifacts, then run the existing analyzer and assignment adapter against the frozen accepted context digest. Preserve raw output separately. The only normalization permitted is to add the three analyzer artifact bindings at `specs/pilot-price/spec.md`, `specs/pilot-price/plan.md`, and `specs/pilot-price/tasks.md`, compute their hashes from evaluator-generated projections of the returned task plan, and record the transformation. Do not alter task semantics or repair invalid output. For the three synthetic cases, no accepted AUT-01 context exists; pass only if every proposal remains non-dispatchable and analyzer/adapter acceptance is explicitly blocked for that reason. Do not invent context to force acceptance.
- S09: record the pilot analyzer fingerprint and findings using the frozen F2 digest. Synthetic cases must not claim an AUT-01 fingerprint. Reuse and rehash the accepted 22-case negative-control evidence. Verify input bytes remain unchanged.
- S12: record prompt/input/skill/source/runtime hashes, task IDs, model/effort, tool policy, usage rows, elapsed time, quota snapshots, and all unavailable values as null with a reason.

## Resource and retention thresholds

For each pair, `nonCachedInputTokens = max(0, inputTokens - cachedInputTokens)`. If available, the median skill-on/off ratio must be <=1.25 and every pair <=1.50. Median total-token ratio must be <=1.50 and every pair <=2.00. Median elapsed-time ratio must be <=1.50 and every pair <=2.00. Missing values for any required token or time metric make that metric unverified and prevent retention.

For every paired ratio, the skill-off value is the denominator. If it is zero, that pair's ratio is undefined, including when the skill-on value is also zero. Mark that metric unverified for the cohort and do not retain AUT-03. Do not replace an undefined ratio with zero, one, an epsilon, or an imputed value. Apply the same rule to monetary cost if cost telemetry becomes available; if monetary telemetry remains unavailable, record null with its reason.

The current subscription runtime does not expose monetary charge telemetry. Record money cost as null/unavailable and make no cost or savings claim. Token caps, input-token growth, elapsed-time growth, and quota stop are the resource-cost proxies. If monetary telemetry is exposed during the cohort, the median paired cost ratio must be <=1.25 and every pair <=1.50; otherwise monetary cost acceptance remains unavailable.

Retain AUT-03 only as a default-off, project-owner opt-in if every skill-on case passes every hard gate, aggregate quality improves by at least 10 percentage points, at least two cases improve, no case regresses by more than 10 percentage points, and all measurable resource thresholds pass. Otherwise record benefit not established and keep the feature default-off. A passing result never authorizes default-on or rollout.

## Final review and baseline gate

Before baseline capture, independently approve this declaration and the exact prompt/input/runtime hashes. The distinct `trial-entry.json` records the authorization and baseline gate; preserve the accepted offline `entry.json` and `delivery-decision.json` unchanged. Immediately before every task, verify the source and binary pins, exact arm settings bytes, record the current quota snapshot, verify the isolated server and workspace, and confirm the active project server remains untouched. Percentage snapshots are evidence only; an explicit provider quota-exhausted response stops the cohort. After the cohort, independently score outputs, have a verifier recheck all hashes and usage rows, then use a separate auditor to review the decision and hard gates. Do not capture a baseline until these prerequisites pass.
