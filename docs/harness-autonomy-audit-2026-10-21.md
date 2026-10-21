# Harness autonomy audit, 2026-10-21

## Conclusion and scope

The reported capacity incident is confirmed. Harness has automatic budget
recovery, but resumable non-budget Lead errors require an incoming message.
Owner interruptions also include recurring environment work and internal
planning failures. Increasing retry counts or relaxing acceptance alone would
not address these distinct causes.

Audit against HEAD c22528e7f47e2fc954ce7c032d51391baccc309f plus the existing
uncommitted HAR-01..04 repairs. Those repairs were preserved. No source changes,
service restart, task resume, deployment, target edits or model trial occurred.
One short-lived native App Server read account limits before explorer dispatch;
it ran no model turn. Local runtime evidence was read through SQLite mode=ro.
Source findings describe current disk code; loaded service hashes were not
verified. Historical incidents cannot establish post-repair effectiveness.

## A1 - High: model capacity failure requires manual continuation

Project c65886082e, task 44ea79b5-3cc6-4ee7-a0e3-8a14404342ff:

- Lead model gpt-6.1-sol started at 2026-10-21T07:42:07.039Z and recorded an
  error after 8,092 ms.
- Stored agent message at approximately 07:42:15.142Z says:
  "Selected model is at capacity. Please try a different model."
  Harness adds "Send a message to this task to retry the failed step."
- Next incoming message ID is capacity-retry-1792570357985. The next recorded
  Lead turn starts at 08:12:38.026Z and completes successfully. The idle interval
  is approximately 30m23s. Latest stored task status is COMPLETED.
- Local Europe/Chisinau times are 10:42 and 11:12. The error establishes selected
  model capacity exhaustion, not a provider-wide outage. The sender mechanism
  of the retry message is not established by its protocol role alone.

Causal path:

1. src/codex-app-server.js:1045 constructs a domain_failure from failed turn
   metadata; process supervision is distinct from model-turn retry.
2. src/contracts.js:1099 recognizes only usage_limit or other.
3. src/lead-graph.js:2829 converts usage limits into budget waits and rethrows
   other errors. A rejected thread resume has a separate fresh-thread fallback;
   that does not recover this terminal model failure.
4. src/server.js:547 republishes a resumable exception as kind=error with
   INPUT_REQUIRED. Its pause representation retains message/name, not a durable
   structured transient category, retry count or next-attempt timestamp.
5. src/server.js:269 registers only waiting_for_budget with the watcher;
   :893 and :906 also limit discovery and resumption to that kind. Enabling
   auto-resume, already default-on, cannot repair this path.

This is a confirmed Harness recovery gap. It does not prove that the underlying
provider made zero internal attempts before emitting the terminal error.

Recommended first repair: introduce structured transient infrastructure recovery
for capacity and eligible transport/service errors. Persist attempt count,
next-attempt time, cause and checkpoint identity. Use bounded exponential backoff
with jitter and restart-safe scheduling. Preserve selected model by default;
model fallback requires an explicit configured policy. Separate capacity,
rate limiting, quota exhaustion, invalid configuration and authentication.
Before worker replay, reconcile effects and writer ownership; never blindly
replay an uncertain write. Explicit owner stop/pause must cancel automatic
continuation. Display the next retry and exhausted-recovery reason in the UI.

## A2 - High: repeated operational work is delegated to the owner

The preceding long task 9e2c8b53-458b-4ccf-924b-ee13639510df contains 14 stored
"Decision required" messages, spanning October 18-19:

| Reason | Count | Observed concern |
| --- | ---: | --- |
| infeasible_requirement | 11 | Environment, external CI, recovery controller |
| loop_detected | 1 | Invalid Lead decision / review wave conflict |
| credentials_or_access | 1 | Reviewer candidate-identity capability |
| paid_resources | 1 | Reported workspace credits |

Of the 11 infeasible-requirement questions, h1-h2 request a supported environment;
h3-h6, h8-h9 and h11-h12 request external CI for successive candidates; h10
requests a supported controller recovery transition. Thus eight questions ask
for recurring CI execution, often including local commit and evidence assembly.

These records establish substantial operator burden. They do not establish that
each individual question violated authority: changed candidates need fresh
verification, unavailable capabilities cannot be fabricated, and paid resources
can require an owner decision. The architectural problem is that the established
verification workflow repeatedly depends on the owner acting as a runner.

Recommended repair: preflight required execution capabilities before a long run,
provide an authorized repeatable verification route bound to candidate content,
and retain the owner's environment/verification decision across candidates.
Fresh evidence remains required after changes; repeated permission questions do
not need to be. Route supported Harness/controller repairs through the system
repair capability when its authorization applies. Keep external writes, new
spending and actual scope decisions explicit.

Existing HAR-03 native-permission work directly addresses part of the historical
capability mismatch. It is already in the dirty tree and has offline evidence;
this audit does not claim it is absent or prove its live effectiveness. Do not
implement a competing permissions bypass based on the old incident history.

## A3 - Medium: internal decision-validation failures become owner decisions

src/lead-graph.js:616 and :2969-2978 allow two correction reminders, then call
escalate(loop_detected). Historical h7 names records_invalid and
review_wave_conflict and asks the owner to continue, change the goal or accept
as-is. That is an internal planning-contract failure, not new product intent.

Recommended repair: retain bounded correction, then use a fresh planning
context or supported internal diagnosis with exact validation evidence. If
recovery is exhausted, record a technical failed/partial result rather than
presenting "continue" as an owner decision. Do not execute invalid assignments
or remove review-wave protection. Current settled no-progress partial handling
is a separate repaired path and should be preserved.

## A4 - Medium: the unmet-goal escalation path lacks an owner-only check

src/lead-graph.js:2648 states that later unmet-goal finishes should pause only
for owner-only blockers. src/contracts.js:1035-1043 verifies a cited later
investigation, but does not enforce the blocker classification.
src/lead-graph.js:3027-3028 then escalates an accepted repeated false finish
without a partial ledger.

An offline probe passes validation for a repeated false finish explicitly saying
that an engineer can repair a local implementation bug within existing authority
and that no owner action is needed. This confirms a contract gap; no specific
historical owner pause above is attributed to this path.

Recommended repair: structured blocker dispositions shared by explicit human
requests and unmet-goal finishes. Implementation repair and infrastructure
recovery stay internal; genuine authority/scope decisions may reach the owner;
exhausted non-owner work can produce an honest partial result. An investigation
citation alone must not establish owner responsibility.

## Verification and evidence

- Independent explorer traced escalation paths; root inspected the reported
  branches and compared them with stored incident messages and usage records.
- Ran `node --test --test-name-pattern='a resumable run error becomes|plain TypeError from a graph step' test/server.test.js`: 2 passed, 0 failed. These tests
  confirm current manual-error-pause behavior, not an implemented repair.
- Ran `node .agents/teamwork/autonomy-audit/probe.cjs`: confirmed local-fixable
  false finish validation and capacity-message classification as other.
- Sanitized local evidence: .agents/teamwork/autonomy-audit/runtime-summary.json,
  error-pause-tests.log, probe.cjs and probe.log. Explorer analysis:
  .agents/teamwork/autonomy-audit-escalations/handoff.md. These ignored files may
  disappear; incident identifiers and conclusions are preserved above. Raw user
  conversations and credentials were not copied into audit artifacts.
- No full test suite was required for this audit. Existing dirty repairs were
  not requalified. No claim is made about live post-fix recovery or deployment.

Implementation priority: A1 first, then authorized verification capability and
persistent decisions (A2), then internal planning recovery and structured owner
boundaries (A3/A4). Acceptance should include transient failure then success,
restart during backoff, exhausted retry budget, owner stop during wait, unknown
writer effects, and no duplicate dispatch or unapproved model fallback.

## Implementation status after the audit

A1 is implemented in `2a9f65a`: bounded durable transient Lead recovery with
checkpoint/writer gates and no automatic model fallback. The local A2 portion
is implemented in `576fbdf`: command-free local verification capability inventory,
existing owner-route reuse, and scoped owner-decision context across bounded
prompts and digests. Capability inventory is not passing verification evidence.
External CI route selection, execution, and runner qualification remain absent;
the historical need for an owner-operated external runner is not claimed solved.

A3 now allows two same-thread correction reminders and one fresh planning
context with bounded validation evidence, then a technical partial result if
planning remains invalid. Automatic infrastructure/budget continuation and an
owner pause preserve the pending fresh-attempt counter and allowance together.
A4 no longer infers owner responsibility from a repeated free-text unmet-goal
finish. After required investigation that path ends as an honest partial ledger;
genuine owner questions use the existing typed `request_human_input` contract.
This reuses the closed owner-only reason boundary instead of adding a second
blocker classification schema. Legacy stored owner escalations remain resumable.

Adversarial checks also exposed and repaired a pre-existing budget-message
admission gap: automatic budget continuation requires enabled auto-resume and a
live `waiting_for_budget` checkpoint pause. A delayed budget message cannot
resume an owner, stopped, or human-decision pause. Manual continuation and valid
budget watcher recovery remain supported.

The local A3/A4 implementation passed independent review and targeted adversarial
probes. Full suite: 1,422 tests, 1,413 passed, 8 unchanged baseline failures,
1 skipped; no new failures. Focused affected suites passed 452/452. No live
provider/model trial, application restart, deployment, or target-project change
was performed. The application remains stopped at the owner's request.
