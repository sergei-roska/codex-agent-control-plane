# Launcher bind failure handoff

Status: implementation complete and frozen for review. Baseline `65a970e` was clean. Worker owns `launcher.js`, `test/launcher-startup.test.js`, and this handoff; root owns Git and coordination. No live service was started or stopped and no commit was made.

`launcher.js` now awaits a real server `listening` event before printing readiness or creating its refresh timer and signal handlers. A bind failure rejects startup; `EADDRINUSE` reports the conflicting loopback port and advises setting `LAUNCHER_PORT`. The default remains 8080; there is no automatic port selection or service shutdown.

Verification:
- `node --test test/launcher-startup.test.js` - 2 passed, 0 failed.
- Conflict test occupies a disposable loopback port and verifies prompt nonzero exit, conflict/hint text, and no readiness line.
- Free-port test verifies readiness and clean SIGTERM exit.
- `node --check launcher.js`, `node --check test/launcher-startup.test.js`, `git diff --check`, and ASCII check - pass.

No full suite was run, as requested. The owner plans to move the live launcher to port 8081 separately; this worker did not start or stop it.

## Root final steering and runtime verification

User explicitly requested8081 as default after worker finished startup fix.
Root changed default8080->8081 and added README launcher URL/override guidance.
Final exact node launcher (no port override) is running as PID1080876, unified
exec session12543. Root verified GET/HTTP200 with HTML and API/projectsHTTP200
with5projects. Earlier user launcher1063513 was terminated; no managed project
server was started, Lando proxy8080 and Langfuse3000 were left intact.
Final startup tests2/2 and diff whitespace pass. Changes remain uncommitted.
Independent critic for optional bind-error repair pending: fresh native quota
9%fivehour40%weekly triggers no-new-agent-turn policy. After reset read current
status/diff, review launcher error handling and accept/commit if qualified.
Default8081 config itself has direct successful HTTP smoke evidence.
