# AD-01 identity contract for implementation slices

Baseline source: `ab5c195`. Product requirement: `docs/autonomous-delivery-backlog.md`, AD-01. These are lead-owned planning decisions for the two bounded implementation slices.

## Identity and scope

- One accepted project task is one owner objective. Its canonical identity is `(projectId, initial taskId)`. The legacy path already uses taskId as runId; the concurrent path keeps its existing deterministic objectiveId derived from projectId and runId.
- Do not merge independent task IDs because they share contextId, similar goals, or the same workspace. Checkpoint/thread/attempt IDs are lineage below the owner objective and do not replace it.
- Initial goal, project/workspace scope, acceptance contract, and required check identities are immutable for that objective. Resume and restart recover them from durable state; they must not be silently supplied from a new message or current mutable settings. If a required binding is absent or conflicts, remain incomplete/unknown and do not dispatch writes.
- Preserve existing attempt IDs and recovery/fencing rules. Persist effective provider/account binding on each attempt where the runtime exposes it. This slice does not implement automatic account selection, failover, wait, or quota resume; those belong to AD-02/03.
- Preserve legacy task compatibility only where an existing durable record contains enough trusted data to recover its required bindings. Do not fabricate missing objective/scope/check evidence. Report any migration behavior that cannot be made safe within the assigned scope.

## Shared checkout constraints

The active backlog-reset documentation changes and `:memory:.lockdb` are pre-existing and must remain untouched. No Git branch, staging, commit, push, deploy, or live provider/quota use. Each worker owns only the path list in its implementation brief. Do not edit tracked planning documents. Coordinate source overlap through the lead.
