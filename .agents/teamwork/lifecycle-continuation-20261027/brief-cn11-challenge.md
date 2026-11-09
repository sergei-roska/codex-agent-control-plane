# CN-11 targeted failure probes

Run only after independent lifecycle review approval and source freeze. Read
challenger role instructions and development-access.md. Own probes under assigned
ignored scratch; do not modify reviewed source/existing tests/expected outcomes.

Hypotheses requiring executable actual-API probes:
1. A pending execute/settings/request-adapter or held remote turn can survive a
   lease expiry/restart; no-effect recovery without exact trusted quiescence must
   not release capacity or send a second writer. Include actual second-connection
   interleaving between proof preflight and settlement if meaningful.
2. Stale owner/control object can record retry/budget/wake or resume after later
   owner pause; confirm no state/event/send and original intent preserved.
3. Two failing independent task scopes cannot consume one strategy cap, and a
   task exhausting no-effect recovery cannot prevent a disjoint ready sibling
   from being claimed/sent. Successful sibling evidence survives transport death.
4. Shutdown has no effects but scheduler is running/unknown: safeToRelease false.
5. Bounded pure-invalid planner output with exact terminal proof can correct;
   an active unknown physical turn cannot be stolen or cause unbounded calls.

Use real store/executor/controller, disposable SQLite reopen/fake barriers and
owned local processes only as necessary. Return HOLDS or minimal reproducible
failure, commands and evidence. No live model/provider/service/account/target/Git
operations. Read current worker/critic handoff first, avoid retesting resolved
facts when the relevant input is unchanged.
