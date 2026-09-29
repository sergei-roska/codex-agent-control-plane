# Resilient orchestration design

Status: proposed. This document records the migration boundary before implementation.

## Objective

Keep A2A as the protocol between the lead and the eight role agents, and keep Codex App Server as the OAuth-backed execution adapter. Use LangGraph for the lead's durable workflow so a run can pause for a usage limit or a genuinely necessary human decision and resume without losing completed work.

LangGraph does not extend account quotas. Its checkpoints occur at workflow boundaries, not inside an in-flight Codex turn. A failed or interrupted node may run again, so external effects must be reconciled before retry.

## Current gaps

- `LeadOrchestrator.run()` keeps rounds, assignments, outcomes, and the lead thread ID in local memory.
- A2A task stores are in memory. Restarting the server loses task status.
- Codex App Server approval requests are declined and user questions receive empty answers. Their details are not routed to the Sol lead.
- A worker's uncertainty reaches the lead only through free-form result text. There is no explicit decision or human-input state.

## Durable run state

Persist a stable run ID, A2A context and task IDs, Codex lead and worker thread IDs, plan revision, assignment IDs, attempt IDs, allowed files, task states, bounded evidence, decisions, approval state, and the last known workspace revision. Do not persist OAuth credentials or the local A2A bearer token in graph state.

Use a durable checkpointer, not an in-memory saver. Select and verify the concrete local storage adapter before implementation. The A2A task store must also survive restart, or the graph must reconcile every outstanding task from a separate durable journal. A graph checkpoint alone cannot recover a lost A2A task.

## Workflow boundaries

1. Accept and validate the request; pin the applicable project instructions and scope.
2. Investigate missing facts with targeted source, test, and documentation searches.
3. Have the Sol lead decide priorities and prepare bounded worker briefs.
4. Dispatch A2A assignments with stable IDs and record submission before waiting.
5. Collect and verify results; reconcile files and task status before any retry.
6. Decide whether to continue, finish, pause for budget, or request human input.

Checkpoint between these steps. A write assignment must not be re-dispatched automatically when its previous outcome is unknown. Reconcile its A2A task ID and workspace effects first.

## Escalation policy

- Luna workers report the exact uncertainty, evidence checked, options, and a recommendation to the Sol lead. They do not ask the user directly.
- The Sol lead checks relevant project instructions and source evidence. It resolves routine ordering, reversible implementation choices, and supported recommendations. It may dispatch a read-only explorer or auditor when a small investigation will settle the matter.
- Use a narrow architecture opinion only for a consequential unresolved decision after evidence review.
- Request human input only for missing authority, a material irreversible or external effect, or a product choice that cannot be inferred safely from the user's goals and project evidence. Include a recommendation and the evidence already checked.
- A denied permission is never silently granted by another agent. Search for an authorized in-scope route; otherwise report the exact blocker.

Represent a genuine human question as an A2A `INPUT_REQUIRED` task with a stable decision ID. The mediator can provide an answer on that task and resume the graph. This is distinct from a worker asking a routine priority question, which the Sol lead should answer.

## Usage-limit behavior

Classify a quota or rate-limit response separately from ordinary tool failure. Persist a `waiting_for_budget` state and stop retries. Resume after capacity returns using the same run ID and a reconciliation pass. Do not claim that an in-flight Codex turn can resume at the exact token where it stopped.

## Implementation order

1. Add explicit worker uncertainty and lead decision contracts, plus the research-first escalation rule.
2. Add durable task and run IDs, persistent checkpoints, and restart reconciliation tests.
3. Move the lead's decision, dispatch, collect, and verify loop into LangGraph nodes while leaving A2A and App Server adapters intact.
4. Add budget pause/resume and rare `INPUT_REQUIRED` handoff to a mediator.
5. Test a restart after each node boundary, a quota failure during a Codex turn, a delayed A2A result, and an uncertain write outcome.

LangGraph's checkpoint, interrupt, and replay model is described in the [official JavaScript guide](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph).
