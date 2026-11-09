# Harness parallelization handoff

Status: implementation and focused verification complete.

## Diagnosis

- `docs/parallel-writers-design.md` and source already define safe grouped waves. `src/contracts.js:876-929` groups consecutive same non-null waves and rejects overlapping writer scopes; `src/contracts.js:902-953` preserves review ordering.
- In `src/lead-graph.js:2617-2619`, the worktree-enabled prompt described wave mechanics but did not direct the lead to put independent writers together. It also named null as the usual path except for explicitly sequential steps. The graph at `:3235-3238` makes null waves singleton groups, so safe disjoint writers defaulted to serial dispatch unless the lead selected a shared non-null wave.
- Read-only runtime DB evidence from `.runtime/projects/c65886082e/state.sqlite`: `lane_probe` contains App Server version `codex-a2a-runtime/0.163.0 (Ubuntu 24.4.0; x86_64) gnome-terminal (codex-a2a-runtime; 0.1.0)`, `ok=1`, `reason=NULL`, checked `2026-10-18T13:26:27.907Z`. `writer_lanes` states: 64 integrated, 103 not_integrated/no_changes, 3 not_integrated/turn_failed. This rules out a stored confinement-probe fallback as cause for that runtime snapshot.
- `src/server.js:761-795` only enables grouped writer dispatch when selected isolation mode is `worktree`; `src/writer-lanes.js:199-216` defaults isolation to worktree but falls back to shared on probe failure. No live process/session was changed.

## Changes

- `src/lead-graph.js`: worktree-enabled instructions now direct grouping independent writers in a shared wave only when their allowedFiles are disjoint and they have no output/state dependency; dependent work and reviewers are ordered in later waves. The disabled branch states that shared-workspace safety serializes writers.
- `test/lead-graph.test.js`: prompt regression assertions cover enabled grouping guidance and the justified serial fallback.

## Verification and pending

- `node --test --test-isolation=none --test-reporter=spec --test-name-pattern='the decision prompt describes waves according to parallelWriters|parallelWriters submits a group together and the next group only after all of it finished|without parallelWriters waved writers still run one at a time in array order' test/lead-graph.test.js`: 3 passed, 0 failed.
- `node --test --test-isolation=none --test-reporter=spec --test-name-pattern='executionGroups groups consecutive equal non-null waves|wave_scope_overlap checks writers of one group for overlapping allowedFiles' test/contracts.test.js`: 2 passed, 0 failed.
- `git diff --check`: passed. The first lead graph test attempt exposed an outdated expected fallback phrase in the changed prompt regression; the assertion was updated to the new wording, then the same focused suite passed.
- No contracts, isolation, admission, or lane safety behavior changed.
