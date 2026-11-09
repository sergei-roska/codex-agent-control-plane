# New session after owner pause

## Objective

Enable New session after a selected session is safely parked by owner Pause or
Stop. Preserve the old session, prevent transition during unsettled work, and
ensure the next message starts a fresh context.

## Ownership and constraints

- Owned files: `launcher-ui/app.js` and focused UI/session tests.
- Preserve copied predecessor changes. No Git staging, commits, pushes, live
  task resumes, service restarts, or backend changes without evidence.

## Acceptance

- Enable only after a matching owner pause or stopped pause is confirmed and no
  worker is running.
- Keep blocked for pause transitions, in-flight sends, pending turns, and stale
  or missing situation data.
- Clear old decision/request state without modifying the stored session; next
  message must use a new context ID and no old continuation task ID.
- Preserve existing terminal-session behavior.
