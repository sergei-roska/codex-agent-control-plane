# Bounded scheduler milestone acceptance

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Acceptance is limited to the scheduler poll rearm repair. It does not accept
CN-14/CN-15 integrated qualification or the pending shutdown/retry-close work.

| Criterion from brief.md | Result | Evidence |
| --- | --- | --- |
| Early callback rearms future polling | PASS | Read retained-original.tap: original fails missing rearm assertion. Independently ran repaired scheduler tests in review-final.md; rearm test passes. Re-ran readable challenger probe at acceptance: early callback rearms at 1 ms. |
| Due callback polls exactly once and ordinary polling remains live | PASS | Independent 44/44 scheduler/executor run in review-final.md; challenger probe independently re-ran at acceptance with two deadlines, exact due polling, and subsequent completion scheduling. |
| Stopped scheduler has no timers | PASS | Independent scheduler tests plus challenger stop/restart timer assertions, re-ran at acceptance. |
| Ineligible, stale, parked and unknown work cannot drive busy polling or resend | PASS | Reviewed pruning, inFlight retention and timer exclusion; independent existing tests pass; challenger removal/unknown/inFlight checks independently re-ran successfully. |
| Preserve concurrent admission and paused submitted drain behavior | PASS | Independent scheduler/executor run covers capacity, siblings, role limits, paused startup refusal and existing submitted settlement. Relevant control/admission branches are unchanged. |
| Existing scheduler and executor tests pass | PASS | Independent 44/44 passed in review-final.md; current files and both frozen-run input hashes match that approval. |
| Regression fails original and passes repaired source | PASS | Read retained-original.tap and original preload mechanism; original fails at missing rearm assertion. Independent repaired run passes. The additional Promise-race regression independently failed rejected source and passed repaired source. |
| Run affected checks and obtain independent critic/challenger evidence | PASS | Frozen affected TAP/JSON independently cross-checked; review-final.md APPROVE and challenge/handoff.md HOLDS with readable probe independently re-ran. Broad known failures are accounted for below. |
| Preserve effect fences, goal/recovery behavior and timeout requirements | PASS | Read source/test diffs in prior review; changes confined to deadline retention, timer selection and regressions. No timeout increase or weakened verification. |
| Narrow scope and preserve inherited inputs | PASS | Independently recomputed all 122 final input hashes: no drift or missing paths. Only scheduler, paired test and two lead-owned docs differ from baseline. |
| Prohibited hostile Git filter test excluded | PASS | Both frozen JSON commands contain the exact required skip pattern. Full summary records one skip; no acceptance check ran this test. |

## Frozen checks and baseline classification

Read actual TAP summaries and failure names, independently matched each to its
JSON, and compared to predecessor verification-full.json and same-suite records:

- Affected: 752 tests, 749 passed, 3 failed, zero skips/cancellations.
- Full: 1,910 tests, 1,898 passed, 11 failed, 1 skipped, zero cancellations.
- Both runs: timedOut=false, inputDrift empty; reviewed source/test hashes match.
- No new full failure names. The additional affected launcher shutdown assertion
  was already a predecessor full failure. The prior direct-resume timeout is
  absent; its historical cause remains unproven.

These broad suites remain non-green. Their known failures are not represented
as successful tests or waived CN-14/CN-15 qualification.

## Documentation and preservation

Read the updated scheduler API paragraph and implementation-status repair and
frozen-check paragraphs. Their claims match source behavior, independent review,
challenger assertions, and verified TAP totals/baseline classification. They
explicitly preserve the historical causality uncertainty, non-green suite state,
unsafe-shutdown terminal reconciliation, cooperative retry-close, and integrated
CN-14/CN-15 pending status.

Independently verified source-start.json/source-final.json cover the same 122
paths, final hashes match all current files, and the two docs contain ASCII only.
Reviewed product/test hashes match reviewed-source.json and both frozen input
maps. No product/test delta occurred after independent approval. No broad tests
were rerun without a specific need; existing valid evidence was reused.

Acceptance-time decisive command:

```
node .agents/teamwork/scheduler-rearm-20261028/challenge/probe.cjs
```

Result: exit 0, PASS for multiple deadlines, in-flight exclusion, early callback,
stop/restart, removal and unknown parking.

Non-blocking: Known broad-suite failures and outstanding shutdown/integrated
qualification remain tracked outside this bounded milestone.

Local evidence is ignored coordination data and may disappear.
