# Background process cleanup handoff

Status: complete; qualified implementation loaded in the active Harness.
Updated 2026-10-19T12:21Z after user confirmed quota reset and continuation.

## Completed

- QA (Quality Assistance) display rename in8existingfiles, canonical verifier
  and legacy orch-verifier IDs preserved. Existing label tests2/2pass.
- Thread-scoped native background terminal cleanup after confirmed terminal,
  before result/writer settlement; independent5stimeout, no callerabort,
  originalgenerationguard and same-thread lock retained.
- Cleanup failure is unknown resource quiescence; samegeneration quarantines
  new turns, existing concurrentturns can clean. Newgenerationclearsfault.
- Final admissionrace fixed: guard repeats after awaitedsetup beforecallback
  and beforeturn/start. No newmodelturn may overtake a cleanupfault.
- Focusedcleanup/concurrency10/10pass. Independent finalreview APPROVE;
  challenger HOLDS,75sequentialassignments and81realownedOSchildren,0alive.
- Native installedAPI emptyephemeralthread list/clean smoke passes,0inference.
- AppServer fullfile had98pass/3fail beforefinalrace regression; relatedsuites
  107pass/2fail. All5failure names/messages exactly reproduce isolatedHEAD
  baseline4b1d756. Evidence baseline-comparison.json and related-baseline-comparison.json.
- Original R129 orphanPID124021/start602698 stopped via verifiedpidfd SIGTERM
  at08:52:27Z; taskterminal and laneownership checked. Its shellparents exited.

## Runtime application

Previous projectserverPID8848 loaded old AppServer hash matchingHEAD. Final
reviewed diskhash:2d66a96b2b8ed2bb6da4f3b7b0b176e719d4fb2425eb223d9091faa461424584.
Runtimebefore evidence runtime-before.json. Project c65886082e, context
cb7ddc85-ce74-4fb8-864b-0f71de97eb28, run9e2c8b53-458b-4ccf-924b-ee13639510df.

At12:15:35Z root requested a TARGETED softpause for this working run, after
verifying noexistingpause/openownerdecision. Evidence maintenance-pause.json.
R156 completed and the pause was reached, but a new owner UI message resumed
the run before stop. The stop guard correctly refused. User confirmed the
manual resume. Message identity web-1792412243115 is preserved, not copied.
Root re-requested softpause at12:18:11Z for R157 verifier and let it finish.
At12:19:19Z the owned pause was confirmed atcollect with terminalbatch and no
open ownerdecisions. Managedproject stopped via launcherPOSTstop. All13captured
old runtimeprocesses, including stale pytest branches, exited; no additional
manualsignals were needed. Evidence old-runtime-tree.json/after-stop-processes.json.

Managedproject restarted at12:19:28Z asPID261953 onport3004. Authenticated
GET/control/runtime proves loaded AppServerhash matches reviewed diskhash above.
Only this maintenancepause resumed at12:19:42Z, preserving exactcontext/run.
At12:20:53Z the first new Leadturn had completed successfully (35481ms), which
requires native cleanupacknowledgement on this codepath; R158 auditor running.
No cleanupfailure or quarantine was observed afterload. Evidence runtime-after,
managed-stop/start/resume and post-load-observation JSONfiles. LauncherteamAPI
also returns QA (Quality Assistance) for verifier.

No goal, ownerdecisions, gates, targetsource or Git history were changed by
maintenance. Existing targetwork proceeded normally until each softpause.

Pre-restart processinventory is historical; all captured old descendants exited.
Do not classify new sandboxwrappers as leaks solely by lane/taskcompletion; a
continuedthread can own runtimehelpers. Never kill by commandname/cwdalone.

## Files and evidence

Source: src/codex-app-server.js, focusedtestupdates test/codex-app-server.test.js.
Docs: docs/background-process-lifecycle.md, READMElink; preserve8QAchanges and
docs/harness-runtime-efficiency-2026-10-19.md. User subsequently requested commit;
8b3fbea records all12taskfiles. Local teamwork notes remain ignored by Git.
Brief/trace/impl-handoff/race-handoff/final-review/challenge are local ignored
coordinationevidence. Challengerprobe /tmp/process-cleanup-challenge-20261019.js
is temporary; report copiedto challenge.md. It uses controlledRPC, not native
Codexmanagedterminalregistration. Native actual0modelturn smoke is separate.

No required work remains. Give concise Russianresult. No further monitoring,
unrelated workflowrepair or test-baselinefix is implied by this task.
The 75-assignment real-child probe uses controlledRPC, not native Codextool
registration; livequalification establishes loadedhash and a successful native
cleanup path, not a 24-hour soak. Fullcurrenttestfile was not rerun after final
racefix; affected10focusedtests and independentoriginalraceprobe passed.
