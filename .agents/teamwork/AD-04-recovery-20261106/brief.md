# AD-04 legacy technical recovery

## Goal

Remove technical retry counters as a source of terminal partial completion or
generic owner questions on the legacy lead path. Keep unresolved required work
active, recovering, or waiting while the system investigates actionable
failures, selects a materially distinct technical strategy when evidence
supports one, and reruns fresh checks. Preserve substantiated owner-only
questions for actual missing owner decisions or credentials.

## Verified context

- `.agents/teamwork/AD-04-05-research-20261106/map.md` maps current behavior and
  the existing regressions.
- `src/lead-graph.js` has repeated-work guards that can force technical partial
  after three observations; `src/transient-recovery.js` persists a bounded
  exhausted state.
- Existing lead-graph tests at the locations in the map expect terminal partial
  for repeated work. Update assertions only to reflect the required nonterminal
  behavior, not to weaken unrelated verification.
- Worktree baseline is shared checkout HEAD `ab5c195` plus uncommitted work.

## Ownership and boundaries

Own this directory and the allowed paths below. Avoid concurrent-delivery files
owned by AD-05 and identity/acceptance files owned by AD-01/AD-06.

Allowed paths: `src/lead-graph.js`, `src/loop-guard.js`,
`src/transient-recovery.js`, `test/lead-graph.test.js`,
`test/transient-recovery.test.js`, and this handoff.

No live provider, quota use, runtime activation, external messages, Git staging,
or commits. Do not change user-facing requirements or convert real missing
credentials into silent retry loops.

## Acceptance

1. Retry or repetition limits cannot themselves produce accepted/partial
   terminal state or a generic "continue" question while required work is open.
2. An actionable local failure keeps the objective active and routes toward
   investigation or a distinct supported strategy; fresh checks gate progress.
3. A missing required credential/authorization remains a precise, evidence-based
   owner dependency and never requests secret text in chat.
4. Repeating unchanged failure remains explicitly incomplete and recoverable or
   reports a real external dependency; it does not claim a distinct repair.
5. Focused tests preserve existing owner-question evidence and cancellation
   controls. Report exact commands and outcomes.

## Report

Update `handoff.md` with changed files, decisions, exact verification, and any
remaining limitation. Do not claim all AD-04 acceptance without evidence for
both technical recovery and substantiated owner questions.
