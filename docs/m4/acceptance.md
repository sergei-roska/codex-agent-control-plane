# M4 acceptance record

Date: 2026-10-01. Candidate: uncommitted working tree on `feature/dashboard-integration`
(base 7d2bb85). Decisions: [implementation.md](implementation.md). Evidence uses the fake Codex
protocol (dev harness `DASHBOARD_DEV_SCENARIO=delivery` and integration tests); Git, branches,
candidates and checks are real. No live model run.

## Exit gate

Gate: a task has an inspectable plan before engineering dispatch; normal, failed, retried, skipped
and revised stages stay consistent with Attempts and Board; QA/Reviewer decisions cannot be
fabricated by the implementing role; each of the nine roles has a reproducible capability check
or representative case.

| Item | Result | Evidence |
| --- | --- | --- |
| Nine public roles | pass | sidebar lists 9 roles (PM first) with model/effort/tier chips and an activity dot during runs; `/roles` marks legacy roles `legacy` |
| Preset-bound plans | pass | feature, bugfix and docs reach review with disposition accepted; audit reaches review read-only with `not_required`; plans carry `presetId@version`, pack id/version and public role ids |
| Pipelines consistency | pass | stage lanes match the run panel and attempts; unavailable presets greyed with "Needs its own contract and pilot" |
| Retry / repair | pass | `[break]` feature: implement = dlv-developer + dlv-developer-xhigh, lane shows "1 repair", review and QA rerun, result accepted |
| Role separation | pass | tests: QA/Reviewer stages cannot be satisfied by dlv-developer; repair chain order xhigh -> sol enforced; coordinator never an A2A endpoint |
| Capability cases | pass (fake) | `npm run roles:check`: 10/10 (PM, architect, developer, qa, reviewer, security, performance, devops, tech-writer, developer repair chain), with negative controls in `test/role-capability.test.js` |
| Legacy pack | pass | `rolePack: "legacy-orch"` keeps M3 rules; M3 suites pinned to the legacy pack still pass |
| Tests and reference | pass | non-M6 suite 648/648; reference manifest OK |

Capability cases on the fake protocol prove routing, sandbox/scope enforcement, report
validation and plan binding, not model quality. `npm run roles:check -- --live
--i-understand-this-uses-my-quota` runs them against the real App Server. It consumes the
operator's ChatGPT plan usage and has not been run.

## Audit

The independent M4/M5 audit found no critical defects in pack or preset authority. M4-related
fixes: `liveStages` read the wrong report location, so finished stages showed failed mid-run. The
role pack is now pinned per run (D-M5-7). Earlier structural defects in the integration
workarounds were replaced properly: migration 4 for plan identity, pack lookups, async submit
validation.

## Limits

- Security, performance, environment and debt presets are unavailable by design.
- Performance audits wait for the performance preset (Performance is a writable role).
- A reviewed ticket still holds the repository lease until cancelled (M3 behavior; M7 adds accept).
