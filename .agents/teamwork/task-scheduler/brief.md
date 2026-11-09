# CN-08 task scheduler

Implement the bounded dependency-aware scheduler in the assigned files only.
Preserve the accepted BacklogStore and TaskExecutor APIs. Add a synchronous
optional claim eligibility callback inside claimReady's immediate transaction.
Use durable claims and captured task contracts as capacity/resource truth.
Keep critical review admission conservative until a trusted frozen-candidate
predicate is injected. No runtime wiring, legacy lead-graph changes, Git,
provider, service, shared DB, or target actions.

Acceptance: resource compatibility, reservation and limits, independent
submitted-attempt polling/settlement, dependency wakeups, startup reconciliation,
typed idle causes, bounded nonprogress, and causal SQLite/barrier tests.
