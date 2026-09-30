# M0 screen pass: Decisions/approval modal

Authority: `artifacts/dashboard/modals/approval.html` and `js/modals/approval.js`. Operator controls require backend-enforced authorization. Fixture-specific command, credential, circuit breaker, security override and scope forms do not define which operations beta supports. M0 command boundaries are settled in the linked contracts; M7 owns UI enforcement integration.

Requirement labels: `[Decision]` records a settled owner decision or an explicit M0 engineering decision; authority is distinguished in [decisions.md](../decisions.md). `[Proposed]` is a replacement behavior for implementation, not existing backend functionality.


## Inventory and extraction

| Control (`id` / selector) | Declared in | Touched by |
| --- | --- | --- |
| `m3-category-badge` | `modals/approval.html` | `js/modals/approval.js` |
| `m3-dynamic-body` | `modals/approval.html` | `js/modals/approval.js` |
| `m3-dynamic-footer` | `modals/approval.html` | `js/modals/approval.js` |
| `m3-modal-title` | `modals/approval.html` | `js/modals/approval.js` |
| `modal-approval` | `modals/approval.html` | `js/modals/approval.js`, `js/app.js` |

Controls: **5**; IDs never referenced by script: **0**.

| Control | Trigger | Mockup behaviour (`file:line`) | Required real behaviour | Undecided |
| --- | --- | --- | --- | --- |
| `m3-category-badge` | escalation open | Set from fixture type config label/icon (`js/modals/approval.js:4-29`). | [Proposed] Show typed, server-issued pending request category. | M7 supported-action presentation |
| `m3-dynamic-body` | escalation open | Replaced with type-specific fixture inputs and explanatory text (`js/modals/approval.js:31,66-389`). | [Proposed] Render only fields for an explicitly supported request type; validate server-side. | M7 |
| `m3-dynamic-footer` | escalation open | Replaced with generic confirm/deny labels for fixture type (`js/modals/approval.js:35,390-433`). | [Proposed] Provide explicit guarded command choice with consequences and preconditions. | M7 |
| `m3-modal-title` | escalation open | Set by type label or fallback (`js/modals/approval.js:9,45-64`). | [Proposed] Identify pending action/decision clearly.| Approved types/copy. |
| `modal-approval` | open/close | Adds `open`, then confirm/deny performs local fixture updates and closes (`js/modals/approval.js:4-43,495-583`; close selector `js/modals/approval.js:585-593`). | [Proposed] Review and submit guarded operator command; durable result and audit event. | M7 |

## Data this screen needs

| Field | Type | Source | Contract? |
| --- | --- | --- | --- |
| escalation id/type/status/target | typed request | fixture selected by ID (`js/modals/approval.js:4-43`) | Approval request contract M0. |
| displayed details/options/payload | type-specific data | render switch (`js/modals/approval.js:66-389`) | Only data required by supported typed decisions/commands; omit unsupported prototype types. |
| operator decision and notes | command/audit record | form read in handler (`js/modals/approval.js:495-583`) | Guarded command/audit contract M0/M7. |

## Simulation boundary

Approval mutations only alter fixture state; type-specific forms are mock templates. OAuth/command/credential/circuit-breaker/security exception/scope changes do not execute real operations. A UI decision is not permission unless backend enforces it.

## M0 resolution and owned follow-up

M0 defines durable decisions bound to ticket/run/revision/plan, with stale decisions rejected after their bound revision changes ([contracts.md, Identity and ownership](../contracts.md#identity-and-ownership)). Requirements clarification, result acceptance, pause/resume, stop, cancel, return-to-backlog and commit/push have distinct command boundaries ([contracts.md, Commands and atomic effects](../contracts.md#commands-and-atomic-effects)). Imported documents are evidence, not permission grants. Prototype-generated generic command execution, secrets, circuit-breaker prompts, security exceptions and scope override forms are not beta approval contracts.

Credential collection and a general vault/editor are outside beta. Codex authentication remains in the installed CLI/App Server; show account status and setup instructions only. Integration credentials may use operator-configured environment/OS secret references, validated when M6 retrieval is configured ([decisions.md, Browser and integration authentication](../decisions.md#browser-and-integration-authentication)). These contracts are proposals for implementation and do not claim existing handler enforcement.

M0 decisions are settled. M7 owns the concrete review/command presentation and enforcement mapping; M6 owns deployment-specific read credentials.

| ID | Question | What it blocks |
| --- | --- | --- |
| `modal-approval` | Map only the supported requirement, review and guarded operator actions to the settled contracts; omit unsupported fixture forms. | M7 |
| `m3-dynamic-body`, `m3-dynamic-footer` | Present request context and consequences for each supported command; do not collect general-purpose credentials. | M7 |

## Dynamic controls

Runtime IDs in generated body/footer include `m3-command-payload`, `m3-cmd-env`, `m3-decision-notes`, `m3-record-adr`, `m3-pm-clarifications`, `m3-secret-value`, `m3-cb-prompt`, `m3-sec-duration`, `m3-sec-justification`, `m3-scope-notes`, `btn-copy-command`, `btn-toggle-secret-visibility`, `btn-escalation-confirm`, `btn-escalation-deny` and per-question `m3-q-${q.id}`, `m3-radio-${q.id}`, `m3-chk-${q.id}` (`js/modals/approval.js:66-433`). The synthetic shell pass accounts for script-only IDs; generated selectors/classes are not stable IDs.

## Gate

`python3 /home/sr/.codex/skills/mockup-to-spec/scripts/coverage.py artifacts/dashboard docs/m0/screens --screen approval.html --list` - **PASS: 5/5 (100%)**. Identifier gate does not validate behavior.
