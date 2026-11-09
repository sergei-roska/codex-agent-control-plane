# Per-account handshake button

## Objective

Add a small handshake button for the system account and every named account in
the launcher account list.

## Acceptance criteria

- Each account row has a compact, accessible handshake button.
- Clicking it probes only that account through its account-specific App Server.
- The row shows connection success or failure.
- Existing unrelated working changes are preserved.
- Do not restart the running launcher.

## Ownership

Lead owns implementation, source review, and project status. No agents assigned.
