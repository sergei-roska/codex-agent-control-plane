# AUT-02 legacy and rollback graph-reader probe

Verdict: PASS for the two bounded reader contracts tested. This is offline evidence, not a live rollback authorization or final milestone acceptance.

Command: `node .agents/teamwork/aut02_design/legacy-reader-probe.cjs`.
Probe SHA-256: `60f52df25b6bc60a6d239722e8c421a9f5b10143ed5339fa1bba9525189dfd98`.
Current graph SHA-256: `c83082c22bc7feedd0bf9b6e72e026c3b0e0176f9926be2208fbc4cb3db3551d`.
Archived baseline graph SHA-256: `c982762654c32f295ccc1893f0f3c878922b9b61928cb1c74221e5d3493c136a` from commit `cc0958edd54a5c7ddaab02e4844fa69b823af365`.

Method [ran]: The probe extracts that exact commit with `git archive` into a disposable temporary directory, symlinks the current installed dependencies, and creates two disposable SQLite checkpointer databases and workspaces. Each reader creates its own checkpoint, then the probe uses LangGraph `updateState` to insert one immutable risk-change obligation with accepted A-target verifier and auditor history. The workspace content changes from A to B before the other reader resumes. The scripted lead tries to finish; `interruptAfter:['decide']` captures the gate response without additional worker execution. The temporary archive, databases, and workspaces are removed on exit. No repository source, existing tests, shared DB, or Git state is changed.

Results [ran]:

| Case | Reader after restart | Recovery state | Gate result | Worker sends |
| --- | --- | --- | --- | ---: |
| Legacy checkpoint -> current graph | Current graph | Missing state defaulted to `{version:1,checkpoints:[]}` | `review_receipt_missing`; next `decide`; status null | 0 |
| New v1 pending recovery checkpoint -> baseline graph | Archived baseline graph | Old reader did not expose `reviewRecovery` | `review_receipt_missing`; next `decide`; status null | 0 |

Both cases retained the same obligation and two historical receipts. The B target differs from the A receipt identity, so neither reader accepted a stale finish. The second case set a v1 `verifier_pending` phase with generation 1 and source IDs. This proves the baseline reader preserves receipt gates while ignoring the new annotation. It does not simulate a pending new-format assignment being dispatched by old code; downgrade while such a batch is active still needs a separate lifecycle/quiescence decision. It also does not test the old direct service, whose continuation guard is known unsafe for live rollback.

Status: complete
Scope expansion: none
