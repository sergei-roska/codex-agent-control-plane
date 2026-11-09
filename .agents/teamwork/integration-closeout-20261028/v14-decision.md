# V14 owner-decision protocol decision

Verdict: REJECT
Status: complete
Scope expansion: none

## Scope decision

The proposed whole-objective gate is acceptable bounded V14 coverage: validation.md:37
requires internal routine choices and mandatory named owner acceptance. It does not
require selective sibling scheduling. target-design.md:299-300 explicitly promises
that deferral blocks only named obligations, so this implementation must remain
labeled a conservative gate, not completed selective deferral. Do not rewrite the
target into a claim that whole-objective waiting satisfies that broader design.

Read: current LeadPlanner accepts ownerDecision as metadata only (:230-264).
Existing waiting_owner blocks planner admission, store claims and engine advance;
engine wait (:789-820) currently lacks its return case. The plan correctly adds a
durable typed request/response, prompt/status projection, default-null compatibility,
store guards, and prompt input_required rather than a repeated model/wait loop.
Read current controller lifecycle pin adoption, authenticated host-controls scope
checks, lifecycle control causes and finalization boundaries. Their existing
mechanisms do not supply the missing decision/control precedence below.

## Blocking protocol ambiguity

worker/v14-plan.md:62-71: every valid reply restores planning/executing, while a
later pause/cancel/correction/takeover retains the request and changes its pins.
A reply using current pins could therefore undo a newer pause/cancel or approve
options investigated under obsolete goal/authority/owner pins. Requiring the old
pins instead strands the request: planner starts and ordinary resume are blocked,
and no refresh/replacement operation is defined. This is an implementable-path
ambiguity at the exact authorization boundary, not a hypothetical style issue.
Evidence: read. Existing transitionLifecycleControl preserves explicit owner_pause,
owner_stop and owner_cancel causes; generic decision resolution must not overwrite
them. Current model metadata and steering have no authenticated rebind protocol.

Fix before implementation: specify control precedence and the exact authenticated
refresh/replacement transition. Minimal safe rules:

- The ordinary reply matches both the immutable request's decision-relevant
  goal/authority/plan/owner pins and current reply pins. Record request pins after
  the registration controlRevision increment, not an ambiguous pre-increment value.
- A control-only pause/stop may allow a newly pinned reply to record the answer,
  but retain that pause/stop disposition and cause; no planner wake that starts
  work. Resume remains an explicit owner operation after decision resolution.
- Canceled objectives remain canceled; reject execution-resuming replies and keep
  request/response history. An answer never implicitly resurrects an objective.
- Goal/authority/owner changes supersede the old question. Expose a typed,
  authenticated refresh/replacement operation with old request digest, current
  full pins, new immutable digest and revalidated obligations/investigation refs.
  Keep admission and acceptance blocked until replacement is resolved. Old replies
  fail. Do not let the model silently rebind owner authority.
- Deduplicate the exact prior reply before requiring now-current revisions, so
  successful retries remain idempotent without repeating wakeups or transitions.

A narrower explicitly specified deny/stale policy is safe, but cannot claim the
planned resumable correction/takeover workflow until a replacement route exists.
Add cases for answer-after-pause, answer-after-cancel, and replaced old reply;
the current proposed tests only saying controls cannot bypass is insufficient to
choose the intended successful recovery transition.

## Other bounded implementation constraints

A reply selects a declared option; it is not itself a new capability for external
writes, spending, credentials or requirement changes. Existing explicit authority
and mandatory verifier/acceptance checks remain required. Reuse HUMAN_REASONS,
require durable relevant investigation and named obligations, and do not create
requests for routine reversible sequencing/recovery. A pending question is not a
provider effect, so drained shutdown may preserve it safely. No source was edited
and no tests, providers, services or broad checks were run for this decision.

Plan SHA-256: 0f027b24892be23044b432f3f914a2a278ab15a2e60fcd6907dd2780754e83b2
