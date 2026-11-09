# Owner-authorized full local autonomy

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read PROJECT and prior
concurrent-startup-20261028 root/lane handoffs, then your junior_worker role file.
English ASCII. User now explicitly grants harness full local rights and asks for
local work without permission questions. This supersedes prior no-config/no-restart
boundaries for root's operational application, NOT workers' own boundaries.
Root owns actual owner settings, service lifecycle and paused-run recovery. Worker
must never change live settings/accounts/native config/DB/processes or call real
models/providers. Disposable offline tests only; no Git writes/installs.

Implement explicit OWNER-ONLY per-project executionPermissions='full-access',
retaining existing inherit/strict defaults and behavior. User wants actual lead,
inspection workers, engineering workers, scoped verifier and agent-proposed final
checks all able to execute authorized local commands with full filesystem/network
access and approvalPolicy=never. Role/task scope still governs intended edits;
mandatory candidate/review/check/publication/owner-correction fences remain intact.
Do not silently replace acceptance with success, remove true external/requirements
owner decisions or allow model JSON to enable this owner setting. No blanket
credential/external publication/spending authority is inferred.

Resolve full access explicitly against actual allowed built-in permission profile
:danger-full-access/native managed requirements. Unknown/unavailable/denied full
access must fail clearly, never silently run constrained or bypass managed policy.
Use permission APIs/sandbox wire correctly. This mode is explicit owner opt-in,
not native config mutation; existing global Codex settings stay unchanged. Default
inherit/strict semantics and modern/legacy behavior remain unchanged otherwise.

Current architecture points to inspect:
- project-settings allows only inherit/strict. Expand validated owner enum.
- CodexAppServer role read-only policies currently override native full access;
  owner full-access must cover those roles explicitly, fresh/prepared/resumed turns
  and turn/start, with never approvals and accurate permission telemetry.
- Scoped verifier currently requires digest of scratch-only workspaceWrite policy.
  Add owner-selected full-access execution policy binding to the existing host-
  owned capability, propagating owner mode from engine factory (not task output).
  Preserve exact candidate identity/current claim/frozen-input integrity checks.
- Concurrent engine cooperative constructor currently requires inherit only;
  allow explicitly resolved full-access mode without faking sandbox confinement.
- Acceptance and preflight only resolve inherited policy for literal inherit;
  extend full-access explicitly so final checks do not fall back to read-only.
- Switching wrapper forwards resolver arguments. Current native lane capability
  code is accepted baseline and must retain behavior for ordinary inherit mode.

Owned source: src/project-settings.js, src/execution-permissions.js,
src/codex-app-server.js, src/concurrent-delivery-engine.js,
src/delivery-role-capabilities.js, src/acceptance.js,
src/verification-preflight.js, src/writer-lanes.js if mode handling needs it;
paired tests for each and test/server-delivery-engine.test.js. Additional path
only report and await root scope decision. Root owns docs/operational settings.
Do not edit launcher UI unless separately assigned. No overlapping source worker.

Acceptance: validation is owner-only and old defaults intact; allowed full access
sends correct full policy/never approvals for lead+readonly+writer+scoped verifier
and fresh/resumed/final-check execution; denial/unavailable does not bypass managed
requirements; inherited/strict tests stay valid; candidate mutation still rejects
acceptance even with full process access. Add composed fake-provider server proof
that actual full-access owner setting starts and reaches verifier/check acceptance.
Tests env -u NODE_TEST_CONTEXT node --test. NEVER run named test candidate attributes
and inherited Git configuration cannot execute filters while mirroring. Full or
acceptance commands MUST include --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'.
No broad full suite; root owns final frozen checks. Test meaningful behavior rather
than mirroring implementation. Report complexity early if beyond bounded Luna
scope, no silent model escalation. Save concise handoff and exact verification
logs/hashes here, coordinate startup_permissions_critic, freeze before final review.
