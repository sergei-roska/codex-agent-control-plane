# AUT-02 baseline and final comparison

Scope: deterministic harness simulations using injected fake App Server/A2A
clients, disposable workspaces, and SQLite state. This comparison makes no
claim about live model quality, token use, cost, production duration, or rollout.

## Frozen baseline

The baseline is pinned in [entry.json](entry.json) to implementation commit
`cc0958edd54a5c7ddaab02e4844fa69b823af365`, Node `v24.21.0`, and the listed
source hashes. The pre-existing focused baseline passed 310 tests in
[existing-baseline.tap](existing-baseline.tap). These baseline counts are not
directly comparable to the larger final suite because the final candidate adds
tests and test files.

Three frozen probes reproduced relevant defects:

| Probe | Baseline result | Final result |
| --- | --- | --- |
| Stale usage-limited auditor on a changed target | [graph-baseline.tap](graph-baseline.tap): failed. Only the original verifier/auditor pair was sent; the expected fresh verifier/auditor pair was absent. | `a stale usage-limited auditor recovers before another lead decision` passes in [qualification-focused.tap](qualification-focused.tap). The final trace records one recovery generation and accepted verifier then auditor receipts on the new target in [automatic-selection.json](traces/final/automatic-selection.json). |
| Direct verifier A-to-B continuation | [direct-baseline.tap](direct-baseline.tap): failed. The stale continuation reached the App Server (3 calls where 2 were expected). | The same-target control and stale-origin test pass in [qualification-focused.tap](qualification-focused.tap). The [final trace](traces/final/direct-verifier-continuation.json) records 3 service messages, 2 App Server calls, and `review_origin_stale`; the stale continuation did not reach model execution. |
| Stable usage-limited auditor | On the exact pre-Q01 runtime hash `6b93da685d44afeadbc573cd84fae2169e0dfc2e949f86c5187bd1a31fb1dd9b`, [qualification-q01-baseline.tap](qualification-q01-baseline.tap) failed: the continuation was skipped as `skipped_verifier_gate` and the run paused for human input. The stable usage-limited verifier control passed in [qualification-q01-verifier-baseline.tap](qualification-q01-verifier-baseline.tap). | Both stable verifier and auditor controls pass 2/2 in [qualification-q01.tap](qualification-q01.tap). The runtime marks a continuable usage-limit auditor receipt as pending, preserving the accepted verifier receipt until the auditor continuation finishes. |

The separate [direct thread-origin challenge](challenge/regression-report.md)
also holds after repair: same-run and cross-run attempts to pair a valid new
target with an old thread are rejected before model execution. It is scoped to
that direct origin/thread mismatch and is not used as sole proof of graph
recovery.

## Final qualification

The focused qualification passed 333 of 335 tests, with 0 failures and 2
sandbox-specific skips, in [qualification-focused.tap](qualification-focused.tap).
The live A2A server and `/var/tmp` probes are skipped there because the
restricted run cannot bind a local listener or write that directory. The
separate Q01 and Q11 runs passed 2/2 and 5/5 respectively. Sanitized final
traces are retained under [traces/final](traces/final), including the direct
service race.

The exact required full project command completed with 1207 passed, 0 failed,
and 1 explicitly gated skip in [qualification-full.tap](qualification-full.tap).
The skip is `live confinement probe against the installed Codex App Server`,
which runs only when `CODEX_A2A_LIVE_PROBE=1`; it is a live environment probe,
not one of the mandatory offline AUT-02 cases.

Q01-Q14 named controls and the reviewed source hashes are recorded in
[qualification-status.json](qualification-status.json). The offline results
qualify bounded routing and receipt correctness only. Retain the existing
failed history, review obligations, receipts, and direct origin guard on
rollback; reverting the direct service to baseline while continuations are
active would restore the demonstrated stale-context defect.
