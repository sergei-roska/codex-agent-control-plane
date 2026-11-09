# Per-account handshake button handoff

Status: source implementation complete; not runtime-verified.

## Changes

- `src/launcher-app.js`: added `POST /api/accounts/:name/handshake`. The route
  force-reads limits and account identity for the selected system or named
  account, returns 404 for unknown profiles, and 502 when the probe fails.
- `launcher-ui/app.js`: added a compact handshake icon button to each account
  row with an accessible name, busy state, and inline result.
- `launcher-ui/styles.css`: sized the button and styled result states.
- Existing unrelated working changes in `README.md`, `launcher.js`, and
  `test/launcher-startup.test.js` were preserved.

## Verification

- No tests or syntax checks were run, because the user did not request testing.
- No live launcher restart was performed.
- The previously recorded launcher state was port 8081; this task did not
  inspect or change that process.

## Next action

If runtime behavior needs confirmation, restart the launcher when authorized,
then click the handshake button on the system account and a named account and
confirm each row reports its independent result.
