# M5 acceptance record

Date: 2026-10-01. Candidate: uncommitted working tree on `feature/dashboard-integration`
(base 7d2bb85), together with M4. Decisions: [implementation.md](implementation.md),
including the D-M5-7 audit hardening. Evidence uses the fake Codex protocol with a scripted
catalog and account. No live model call and no probe turn was made.

## Exit gate

Gate: changing a role default affects a new run, appears in its history, and does not alter an
existing or resumed run. Invalid or unsupported choices are rejected before dispatch. PM
configuration is included rather than left hardcoded.

| Item | Result | Evidence |
| --- | --- | --- |
| Account health | pass | Connections tab: connected ChatGPT account, plan, 5 h and 7 d rate-limit windows; Add Provider disabled; requires_auth / unsupported_account states covered by tests |
| Save and history | pass | Developer saved as gpt-6-luna / xhigh / fast; history shows the revision; banner "Applies to new runs only" |
| Pinning mid-run | pass | ticket A running when Developer changed to sol/medium: A's Settings tab and its Developer attempt (requested and reported) stay luna/xhigh/fast; new ticket B pins sol/medium |
| Resume keeps pinned values | pass | tests: resume after a lead human decision keeps the run's settings; graph pins settings like the plan |
| Validation before dispatch | pass | effort options limited to the model's supported values (gpt-6.1-sol: medium/high); invalid saved default -> submit 409 `settings_invalid`; catalog down -> Connections "Model catalog unavailable" with Retry and submit 503 `catalog_unavailable` |
| Reset | pass | Developer reset -> source "profile" |
| PM configurable | pass | `dlv-project-manager` (delivery) and `orch-lead` (legacy) are editable roles; the coordinator entry drives Intake and every lead turn |
| Legacy pack | pass | with `rolePack: "legacy-orch"` the tab lists orch-lead and orch-* incl. repair roles; a saved orch-builder default (sol/low) is pinned in a new legacy run and matches the attempt's requested settings |
| Service tier | pass | `serviceTier` sent only when set (thread/start, thread/resume, turn/start); null shown as "Default (not sent)" |
| Tests and reference | pass | non-M6 suite 648/648; reference manifest OK |

## Audit

The independent M4/M5 audit found one major defect: legacy-orch mode listed and saved defaults
but never applied them. It also found minor defects: role pack not pinned per run, catalog vs
pinning format mismatch, unchecked `effectiveSettings` metadata, uncached catalog failures, fake
`reported` values on loaded threads, and tier wording. All are fixed per D-M5-7 and covered by
tests. The major and pack-pinning fixes were re-verified in the browser.

## Limits

- Catalog presence is not proof of account entitlement. A tier or model the account cannot use
  fails at turn time, with the error shown on the run.
- Saved defaults apply to dashboard delivery runs only. CLI/A2A runs without delivery metadata
  use profile values.
- Requested settings are what this server sent. Reported settings come from the App Server's
  thread responses and are "not reported" on turns without one.
