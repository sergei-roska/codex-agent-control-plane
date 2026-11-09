# Independent review: thread cleanup

Verdict: APPROVE

Evidence (read): The diff is limited to `src/codex-app-server.js` and `test/codex-app-server.test.js` within worker ownership. The run retains its `runs` entry through the cleanup RPC, so a same-thread continuation cannot overlap it. `_cleanupTerminal` checks the captured child state and generation before sending a thread-scoped request. It runs only after `turn/completed`, has its own timeout, and does not use the caller abort signal. Errors preserve `originalTurnOutcome` and set `outcomeUnknown` for started turns; A2A then withholds writer settlement and lane integration.

Evidence (read): I traced the cleanup failure through `a2a-role-service.js:1066-1088`, `writer-admission.js:265-282`, and `process-quiescence.js:106-125`. Reconciliation calls `killOrphanProcessGroup`, but that helper refuses to signal the live shared App Server leader when its parent is the current process. The unresolved writer remains held. This resolves the apparent shared-process kill risk in the failure path.

Evidence (ran): The seven cleanup/concurrency focused tests passed (7/7), and `git diff --check` passed. Root independently compared the three existing App Server failures and two related-suite failures against an isolated HEAD baseline; names and messages matched. Native empty-thread RPC smoke was reported by root; I did not run live inference or a real background-terminal termination probe.

Non-blocking: The fake-RPC tests prove ordering and failure metadata but do not demonstrate termination of a real background process. The installed protocol and native empty-thread smoke support the API path; a disposable real-terminal probe remains useful integration evidence for the milestone.

Status: complete
Scope expansion: none
