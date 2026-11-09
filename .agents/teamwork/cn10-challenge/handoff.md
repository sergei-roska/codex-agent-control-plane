# CN-10 challenger handoff

Status: complete. Verdict: HOLDS. Details: `challenge.md`; current runnable probe: `probe.js`; prior race reproduction retained as `probe-prestructural.js` for history only.

Verified command: `node .agents/teamwork/cn10-challenge/probe.js` (seven PASS, exit 0). The two adapted race probes commit the winning call after the losing preflight SELECT and before its transaction; references, events, and candidates survive the loser conflict and garbage collection. The former addReference-hook injection is invalid after the structural fix because it creates a same-connection savepoint inside the loser transaction.

No product source, existing tests, fixtures, config, project Git state, service, or target action was changed. Only this ignored challenge directory was written. Disposable roots under `/tmp` are cleaned by the script. No pending challenge work in the assigned scope.
