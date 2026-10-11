# ADR: Launcher reads live run state from the lead checkpoint

Status: accepted 2026-10-11. Implemented in `39a3a3e`. Design:
`docs/session-situation-design.md` (SIT-1, SIT-2).

## Decision

The launcher projects the live state of a session (phase, round, current
batch, open decisions, progress, acceptance, next steps) directly from the
latest LangGraph checkpoint of the session's lead task in the project's
`state.sqlite`, opened read-only:

- thread id = lead task id; row with `checkpoint_ns = ''` and the highest
  `checkpoint_id`; decoded with the package's default serde
  (`new BaseCheckpointSaver().serde`), so saver setup/writes never run;
- node = highest-version `branch:to:*` channel; phase is mapped from node and
  A2A state;
- when the batch is null after a round closes, the last round's outcomes are
  projected; changed files prefer engine-measured
  `writer_executions.delta_json.changedPaths` (`known = true`) over the
  worker's self-reported `filesChanged`;
- fields that cannot be derived are null or empty, never invented.

Project git status comes from `git status --porcelain=v1` and
`git diff --shortstat HEAD` via `execFile` (argv, no shell, 3 s timeout,
`GIT_OPTIONAL_LOCKS=0`).

## Alternatives considered

- A new status method on the project A2A server: rejected for now; adds code
  to the lead's server and works only while it runs, while the checkpoint is
  readable even when the server is stopped.
- Persisting a separate "situation" record from the lead loop: rejected;
  duplicates the checkpoint and touches the lead loop.

## Consequences

- The launcher depends on the LeadState shape and the checkpoint format; a
  change to LeadState fields or the saver serde must update
  `src/session-situation.js` and its fixture tests (fixtures are written with
  the real `SqliteSaver.put`).
- Progress entries have no timestamps (`progress[].at` is always null).
