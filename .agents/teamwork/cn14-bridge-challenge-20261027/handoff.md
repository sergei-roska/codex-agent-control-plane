# CN14 bridge challenge handoff

Status: complete. Verdict BROKEN for scoped verifier turn-start authorization. See report.md and owned probes in this directory.

Verified: Capability probe sent one `turn/start` after synchronous owner pause in `onTurnStart`; the later verifier objective check rejected and no receipt settled. Artifact revocation during actual WriterAdmission wait refused without patch/candidate; same-command duplicate projected pending state and caused exactly one detached apply.

Commands:
- `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-bridge-challenge-20261027/probe-capability.js`: 1 failed as intended.
- `env -u NODE_TEST_CONTEXT node --test .agents/teamwork/cn14-bridge-challenge-20261027/probe-artifacts.js`: 2 passed.

Changed files: owned brief.md, report.md, handoff.md, probe-capability.js, probe-artifacts.js only. No product changes. Next action for root/worker: add scoped authority recheck after `onTurnStart` in CodexAppServer._run, then rerun this probe and affected tests. No broader CN14 gate claim.
