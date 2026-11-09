# A3/A4 lead handoff

Status: implementation frozen for independent review. Worker `/root/verification_capabilities` owns scoped source/tests/docs. Root owns Git and coordination. Baseline A2 commit `576fbdf`; no commit made. App remains owner-stopped; no live provider, app, or target actions.

Implemented A3: two same-thread correction reminders, one fresh Lead planning context with bounded exact validation evidence and current owner/review/run context, then technical partial on invalid recovery. The selected model/profile stays the same. Failed provider turns and automatic budget/transient resume retain the allowance and validation evidence. Forced partials run acceptance once, do not re-enter repair/review, and honor an owner pause before acceptance.

Implemented A4: repeated `goalAchieved: false` after required investigation produces technical partial; missing required citation stays rejected; owner-only decisions use typed `request_human_input`. Legacy persisted owner escalation remains resumable. Docs clarify local A2/A3/A4 scope and that external runner qualification remains absent.

Verification:
- `node --test test/lead-graph.test.js test/lead-orchestrator.test.js test/contracts.test.js test/server.test.js` - 452 tests, 452 pass, 0 fail, 0 skipped.
- Server gate regression and live watcher positive path pass. The retained adversarial probe expects the old bug and now fails at its expected `resume` count of 1 (actual 0), confirming rejection; probe is owned by challenger and was not edited.
- `node --check` on `src/lead-graph.js`, `src/contracts.js`, `src/lead-orchestrator.js`, `src/server.js` - pass.
- `git diff --check` and ASCII check for changed source, tests, and docs - pass.
- Full repo suite not run by worker; root owns final full suite. Temporary focused output: `/tmp/a3a4-focused5.log`.

Next: independent critic and challenge per root coordination; then root runs full suite and owns integration/Git. Do not start A3/A4 live trials or claim external CI qualification.

Root full suite at frozen review checkpoint:1416 total,1407pass,8 unchanged
baseline failures,1skip,no new failures. Evidence full-tests.log and
full-comparison.json. Independent critic still pending.

## Final lead acceptance

Critic APPROVE and challenger HOLDS, including final budget admission delta.
Accepted full suite:1422total1413pass8unchangedbaselinefail1skip,no new failures.
Evidence accepted-full-tests.log, accepted-comparison.json, review.md,
challenge.md and probes/. Focused affected suites452/452 pass. Owned temporary
hidden probes removed from test/ and retained only under ignored probes/.
No live application/provider/model/target/deployment action occurred. Local A2,
A3/A4 accepted; external CI route execution/qualification remains unsupported.

Committed as65a970e after localA2 commit576fbdf. Working tree clean.
Final process inspection found no Harness application processes. Fresh final
native quota17%fivehour41%weekly. No pending localA3/A4 verification or agents.
External runner route/qualification remains open; no live restart authorized.
