# Owner correction replay repair

## Scope

Own only `src/backlog-store.js`, `test/backlog-store.test.js`, and this local
notes directory. Repair owner correction authorization on exact source replay.

## Acceptance

- Run synchronous literal-true trusted authorization inside the immediate
  transaction on each normalized invocation, including exact replay.
- Keep exact replay exempt from stale expected revisions and avoid repeat state
  changes/events; reject source payload conflicts.
- Keep default false, asynchronous, and other non-true results denied.
- Add meaningful coverage for revoked replay authorization, authorized replay
  after revisions advance, and unchanged state/events for rejected replay.
- Run affected contract, store, event, and scheduler tests plus syntax/diff
  checks. Do not use services, providers, model trials, Git mutations, or live
  state.
