# AUT-03 revised controls review 4

Recorded: 2026-10-17T08:22:46Z

Verdict: APPROVE.

Scope: read-only static review of the proposed per-task turn-cap revision,
cohort-2 stop evidence, gate state, account policy, existing isolation controls,
and cross-document hashes. No service, task, model call, or project test was
started.

Reviewed artifacts:

- `trial-entry.json`, SHA-256
  `23086780d5d59533d75089f6a6fee32f1633e6e10407104ea02304a800b83e91`
- `paired-trial-declaration.md`, SHA-256
  `bdb98633b7322cf0aba80c1301a1d2f6d3308c65551ad5997e1eb398ed99a75e`
- `trial-runtime-pins.json`, SHA-256
  `5a48a55b4551becbdcabbdf10ed867cfdabfe5e0df58591000a2ced435a249c3`
- `trial-server.js`, SHA-256
  `fafd4ff9c030f5731e84fe1269c7a38dd007e8da3c88d5d6746c2e79da2d8c00`
- `cohort-2-turn-cap-stop.md`, SHA-256
  `45b589294f282e0ac5444baf83f33169b13736c5b89203e997610718ae4046c6`

Findings:

- The declaration, runtime pin, trial entry, and helper consistently allow
  eight lead `turn/start` submissions. The helper counts attempts and rejects
  request nine before calling the original App Server request method, writes
  the stop attestation, and terminates the dedicated trial process.
- Cohort 2 evidence shows three requests sent and the fourth blocked. The task
  is incomplete; the entire cohort is excluded from scoring. The baseline gate
  remains false pending review and fresh preflight.
- The 240-second task timeout and per-task/cohort token budgets remain declared.
  The quota override remains limited to displayed percentages; explicit
  provider quota exhaustion stops the cohort, and account switching remains
  prohibited.
- The existing worker removal, native-tool restrictions, read-only empty
  workspace, pinned account, and per-task restart controls remain intact.
- Helper, declaration, runtime-pin, prompt, and stop-report hashes match their
  current cross-document pointers.

No blocking finding. A fresh paired cohort may begin only after the final
review pointer is recorded and fresh task preflight passes.
