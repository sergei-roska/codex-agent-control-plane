# Project instructions

These instructions supplement inherited lead/worker rules. Product code, tests,
scripts, and build configuration changes belong to scoped implementation workers.
The lead owns planning, documentation, integration, and verification.

## Immutable dashboard reference

- `artifacts/dashboard/**` is the owner's protected reference prototype. Treat
  every file there as read-only, including HTML, CSS, JavaScript, assets,
  `build.js`, and generated `index.html`.
- Do not edit, format, rename, move, delete, or overwrite files in that directory.
  Do not run builds, generators, or tools that write outputs into it.
- Use `web/dashboard/**` as the independent working copy for the application.
  If it is absent, copy the reference there before integration. Use ordinary file
  copies, not symlinks or hardlinks to protected files.
- Implement all dashboard changes and generate all dashboard build outputs only
  in the working copy or other explicitly assigned application paths. The
  application must not use the protected directory as its writable runtime UI.
- Continue to cite the reference when extracting requirements. Changes to the
  working copy do not change the original design evidence.
- Include a check that `artifacts/dashboard/**` remains unchanged in dashboard
  implementation verification. A source/build copy operation must never write
  changes back to the protected reference.
- Editing the reference requires a new explicit owner instruction naming the
  protected path. General requests to implement, integrate, or fix the dashboard
  do not authorize such edits.

## Delivery planning

Follow `docs/beta-master-plan.md` and its linked decision records. Keep the
Battle Pass prototype unchanged and outside beta implementation scope.

## Session continuity

While a milestone is open, start every session by reading its handoff,
currently `docs/m9/session-handoff.md`: owner decisions in force, evidence,
pilot state, next steps, and deferred follow-ups. Verify the state it names
before acting. Update the handoff at each checkpoint and commit verified work
promptly on the feature branch; push, merge, tag, and publication need the
owner's separate instruction.
