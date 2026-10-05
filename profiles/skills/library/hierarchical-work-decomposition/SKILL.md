---
name: hierarchical-work-decomposition
description: Turn a project goal into a verifiable master plan, milestone gates, phases, epics, and independently executable tasks. Use when creating or revising a multi-phase roadmap or work breakdown for human teams or AI agents.
---

# Hierarchical Work Decomposition

Use this skill to produce or revise a plan whose leaves can be executed and verified independently. Apply it to any project or executor. Preserve the project's established plan format and calibration when they exist.

## Invariants

Apply these at every level:

1. **Outcomes:** Name the result that exists when a node is done, not an activity. For example, "Users can reset a password," not "Work on auth."
2. **Verifiable done:** Give each node acceptance criteria another person can check without consulting its author.
3. **Exact coverage:** A parent's children together deliver the parent's outcome, with no gap, overlap, or extra work.
4. **Explicit dependencies:** Record dependencies by node ID. The dependency graph must be acyclic; list order does not imply a dependency.
5. **Unknowns first:** If a dependent task cannot yet be specified, add a timeboxed spike with a decision record as its output before committing to that task.
6. **Rolling-wave depth:** Decompose only the current and next phases to tasks. Keep later phases at epic level until they approach execution.
7. **Minimum levels:** Include a level only when it adds coordination value.

## Levels and branching

### Level 0: Master plan and milestones

Record the goal, scope, explicit non-goals, and constraints. Define milestones as verifiable state transitions between phases, not dates or activities. Each milestone has an ID, exit criteria, and the work it unblocks. A phase spans two consecutive milestone gates; its outcome is the next milestone's exit criteria.

### Level 1: Phase

Use Level 2 epics if **any** of these applies:

- The phase has more than one independently deliverable outcome.
- It touches more than one component or write scope.
- It needs parallel execution or more than one executor.
- It includes an external integration, such as a third-party system or another team.
- Its expected task count or duration exceeds the project's calibration.

Otherwise put Level 3 tasks directly under the phase.

### Level 2: Epic

An epic is an independently deliverable feature, work package, or end-to-end user scenario with its own acceptance criteria.

Use a **contract-first** sequence if the epic crosses a boundary between separately built components (for example UI, API, service, storage, or an external system), or if its parts must be built in parallel:

1. If the contract cannot be specified, create a timeboxed spike whose output is a decision record. Make the contract task depend on it.
2. Create a contract task that fixes the interface, including the API or data schema, events, error model, versioning, and examples as applicable. Done means the reviewed contract is published as an artifact, such as a schema file, mock, or stub, that consumers can build and test against.
3. Create implementation tasks, one per side of the boundary. Each includes its own tests and depends on the published contract. They may run in parallel when their write scopes are disjoint.
4. Create an acceptance test task against the contract. It may run in parallel with implementation.
5. Create an integration task that joins the sides and runs acceptance tests end to end. The epic is done only when this passes.

Once implementation starts, a contract change reopens the contract task. Mark every dependent task stale and re-verify it. No side changes the contract unilaterally.

If the epic stays within one component and needs no parallel work, use one task to implement the entire epic.

### Level 3: Task and subtask

A task is an atomic unit for one executor. It must have:

- One outcome, with no title joining two results with "and."
- A stated write scope disjoint from parallel sibling tasks.
- Ready inputs: dependencies done or their contracts published.
- Done criteria that a command or test can check, or a reviewer can verify in one pass.
- A size within the project's calibration: one brief, one session, one reviewable diff for AI agents; normally 2 hours to 2 days for a human team.

If a check fails, split the task or add the missing dependency. If it is below the lower size bound and lacks independent verification, merge it into a sibling or demote it to a subtask. If it cannot be estimated, expose the unknown as a spike.

A subtask is a checklist item inside a task, such as review, migration, deployment, or documentation, when separate tracking adds no value. It has no executor or dependencies of its own. Promote it to a task if it needs either.

## Default calibration

Use project-specific calibration when supplied. Otherwise:

| Parameter | Human team | AI agents |
| --- | --- | --- |
| Phase needs epics when task count exceeds | About 7 | About 7 |
| Phase needs epics when duration exceeds | About 2 weeks | Not applicable |
| Task size | 2 hours to 2 days | One brief, one session, one reviewable diff |

## Node records and plan output

Record every node with `id`, `level`, outcome title, `parent`, acceptance criteria, and `depends_on` IDs. Record each milestone's exit criteria and what it unblocks. Record each task's write scope, executor, estimate, and subtask checklist. Make spike timeboxes and decision-record outputs explicit. Identify the critical path through the dependency graph.

Use the destination's existing format when possible. A table, issue hierarchy, or structured document is acceptable if these fields and relationships remain visible. Do not invent task detail for later phases just to fill the hierarchy.

## Re-planning triggers

- When a task exceeds its size or timebox, stop and re-split the remainder.
- When a contract changes, reopen it, mark consumers stale, and re-verify them.
- When a milestone gate fails, keep the next phase closed and add fix tasks to the current phase.
- When a phase becomes next in line, decompose it to tasks.

## Validation before acceptance

Check the plan, then repair any failure:

- Every milestone has verifiable exit criteria and states what it unblocks.
- Every node's children cover its outcome fully, without overlap or extra work.
- Every leaf passes the task checks above.
- Every boundary-crossing epic has contract and integration tasks, with implementation and acceptance tests against the contract.
- The dependency graph is acyclic and its critical path is identified.
- No parallel tasks share a write scope.
- Only the current and next phases contain tasks.

Avoid splitting by activity such as "design," "code," and "test" when a behavior can be delivered in one task; include tests in the task delivering that behavior. Do not add levels for completeness, define milestones as dates, leave a spike without a specified output, or hide dependencies in list order.
