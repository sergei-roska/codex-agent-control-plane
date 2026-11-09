# Cases audit handoff

Completed read-only review of the frozen snapshot for four concrete episodes. Evidence and bounded interpretations are in `cases.md`.

- Snapshot was opened with SQLite `mode=ro`; no Harness dispatch, source access, target mutation, test execution, or external service was used.
- Assignment usage joins dispatch task IDs to usage ledger task IDs. Source timestamps are UTC; reported ranges are converted to Europe/Chisinau (UTC+03). Elapsed is summed directly from elapsed_ms and tokens from totalTokens; these are task metrics, not prorated wall time. Confirmed r71-r85 ends 2026-10-18 20:15:13.458 UTC / 23:15:13.458 local on October 18.
- Strongest findings: (1) completion checkpoint reviews were blocked by candidate identity and asyncio/TestClient environment failures after an initial real repair; (2) daemon audit cycles found distinct lifecycle races and later reconciled external evidence; (3) rework intent cycles found multiple distinct implementation/test defects, with a migration-path scope blocker on r73; (4) r128 was a zero-token stale-review retry and r129 remained incomplete on recurring TestClient hangs and unavailable evidence IDs.
- Duplicate search is not provable from role/count/checkpoint repetition or these snapshot records. Root reported that actual rollout logs are available under `/home/sr/.codex/sessions/2026/10/{18,19}` and owns inspection of search patterns; this report does not claim otherwise.
- The r129 result is the final assignment within the frozen cutoff. Exclude subsequent live assignments.
