# Final quota checkpoint

Status: source work accepted/committed; comparative live qualification incomplete.
No goal active. Quota94%5h/31%weekly at2026-11-05T15:28:03Z; policy threshold90%.
No new native task or agent turn after this observation. All in-flight workers and
reviews finished; root full validation and local commit completed.

Commits42af839,4192a08,ab5c195 on main, no push. Git clean except preserved
:memory:.lockdb. Final full2106pass0fail1skip,total2107,65.951s,341pins/no drift.
Dependency standalone/embedded schema version fix independently APPROVED; previous
role-scope and supersession fixes APPROVED. Durable docs/status/matrix/summary current.
UI8082/backend3002 restarted empty project on final source, ready/taskReady; see
ui/final-ready.json. No old runtime/global config/target changes from this work.

Actual first/second native runs remain incomplete, only coordinator turns19471/
20478tokens. First failed empty writable scope before dispatch; second failed
standalone dependency record version before task admission. Both source defects
fixed and regression-qualified. No actual native accepted recovery or matched
Legacy comparison yet, no economy/L6 claim. Source fixes are not model replay.
Both owned native provider groups and verified runner processes stopped; engine
safe close failed and retained phase provider_closing/ownership. All backups,
raw native output/usage and OS stop facts remain under live-runner/ and qualification/.
Never replay/delete these held roots or force claims released.

Next after user resume/quota reset: read ../PROJECT.md, actual quota and Git/UI
state. Run fresh disposable matched pair on ab5c195 with current reviewed collector
and revised identical intake. Review actual DB histories/candidate/check streams
and complete recovery trace independently before declaring L6. Initial router
mapping may lack objectiveId; use finalMapping + raw DB, not empty taskSnapshot.
Model-independent collector probes and fixture controls already pass; rerun only
if their inputs change. No production/Jira/push/deployment authorization added.

# Resume checkpoint 2026-11-05 17:45 EET (lead)

Preconditions re-verified: HEAD ab5c195, tree clean (only :memory:.lockdb), isolated UI
8082/backend 3002 up. Actual Codex quota read at 15:41:56Z: primary 97% (stop threshold
90%), resets 1793905751 = 19:09:11Z = 21:09:11 EET; weekly 31%. Runner gate
quota_unknown_or_at_stop_threshold would refuse. No arm started; no model call made.

Next executable step after the reset (re-read quota first; start only below 90%):
  cd /home/sr/Projects/Workspace/codex-agent-control-plane
  node .agents/teamwork/closeout-20261105/live-runner/run-comparison.js concurrent-v1 --go
  node .agents/teamwork/closeout-20261105/live-runner/run-comparison.js legacy --go
One arm per invocation, bounds 900s / 180s turn / 20 native turns / 300000 tokens.
Run Concurrent first, review its recovery trace independently, then Legacy.
Quota helper: any read-only CodexAppServer.readRateLimits call (the runner does it too).
Intake (identical for both arms) is the revised goal in run-comparison.js. The second
failed arm's DB (/tmp/harness-cn15-20261105-lFss6U/state.sqlite, delivery_run_engines.
request_json) holds the same revised goal and the verify-product check; the first arm
(qaK7xX) holds the pre-clarification goal. Do not resume those roots.

# Third Concurrent attempt 2026-11-05 18:10 EET (lead) - incomplete, not a defect

Owner authorized running at 97% Codex quota (explicit, gpt-6-luna low). Runner gained
--quota-stop-percent=<1..99> (default 90, recorded in evidence.quota; not in input hashes;
probes pass). Run: concurrent-v1 --go --quota-stop-percent=99 on ab5c195.
Arm 5b588f4e-498b-4eda-8975-b8e096381770, root /tmp/harness-cn15-20261105-M1NGRy,
evidence live-runner/concurrent-v1-1793893677027.evidence.json.
First arm past planning: failed read-only probe, explorer investigation, steering
accepted (200), one engineer repair (sum-positive.js, scope clean, check unchanged).
Stopped by the runner's own bound: observed_token_limit_reached at 339526 tokens /
9 native turns (bound 300000, checked per turn), wall 91.9s. Final task INPUT_REQUIRED
(planner_turn_error after the stop), productCheck exit 1, objective not accepted,
safe close failed (concurrent_shutdown_unsafe, same as arms 1-2). No provider groups
left; runner pid 1758046 SIGTERMed and verified gone 16:11:17Z. Raw snapshot:
live-runner/third-arm-post-close.state.sqlite; pre-close backup also retained.
Root retained, never replay. Coordinator input grew 19k->47k per turn (mostly uncached).
Quota after: 98% (about 1% per 340k tokens, rough). L6 still unconfirmed.
Open owner decision: per-arm token bound (300k too small for this scenario).

# Owner decision 2026-11-05 ~18:20 EET: wait for the quota reset

Owner chose to wait (reply to the option "raise bound to 1.2M per arm, run both arms
after the 21:09 reset") and closed the session. Codex 5h quota 98% used, resets
1793905751 = 21:09:11 EET. Plan on resume (re-read quota first; need < 90% or use the
explicit --quota-stop-percent override only with fresh owner authorization):
1. Worker adds an explicit --max-observed-tokens=<n> option to run-comparison.js
   (default stays 300000, recorded in evidence.budgets, outside input hashes), plus
   probes. Use 1200000 for BOTH arms (identical bound; value recommended by lead,
   owner agreed by choosing "wait" - confirm the number once on resume).
2. Run concurrent-v1 --go, then legacy --go, one arm per invocation, same bounds.
3. After each arm: verify no owned provider groups, SIGTERM only the exact runner
   pid if it lingers, take a raw post-close snapshot, never replay held roots.
4. Critic reviews the Concurrent recovery trace from the raw DB (failed probe ->
   investigation -> distinct repairs with supersession -> fresh verifier -> host check
   -> durable acceptance) before any L6 claim. Legacy has no steering: report asymmetry.
