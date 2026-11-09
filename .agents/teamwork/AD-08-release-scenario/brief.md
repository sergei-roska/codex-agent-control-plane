# AD-08 deterministic release scenario plan

## Objective

Read-only design the smallest executable deterministic test for AD-08's full
legacy or concurrent release lifecycle, using existing server/provider fixtures.

## Required output

- Choose the runtime path based on current AD-02/03 wiring and the backlog's
  release scenario.
- Name exact existing fixtures/helpers, scripted provider call sequence, state
  assertions, and likely changed test files.
- Cover A exhaustion, transfer to B, B exhaustion and durable wait, real
  `startServer` close/reopen, restored availability, same-objective continuation,
  mandatory check and accepted state.
- Identify how owner pause/cancel races and non-accepted recovery cases can be
  added without obscuring the primary happy path.
- Distinguish verified existing capabilities from proposed test behavior.

## Constraints

Read-only. Do not edit, run tests, use live providers or credentials, stage, or
commit. Use English and ASCII.
