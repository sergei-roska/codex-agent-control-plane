# Frozen live runner review

Verdict: REJECT before GO. Reviewed actual run-comparison.js and fixture bytes,
trial design, runtime close/startup code, native usage/error behavior, inbox and
SQL schemas. No provider/task/service call or reviewed-file edit performed.
Product schema repair is a separate review and was not assessed here.

## Blocking

1. run-comparison.js:401-404 - Real inbox receipt timestamps are INTEGER epoch
   milliseconds (delivery-inbox.js:40,72,91), but Date.parse(number) produces NaN.
   Ran the actual steerOnActiveTurn helper in a VM with only fetch mocked and a
   real-shaped applied receipt inside a completed worker interval: expected
   receiptWithinTurn=true, actual=false. Additionally only received time is
   checked, not applied time. Polling exits immediately on applied while the
   worker can still be active, freezes turnCompletedAt=null, and never recomputes
   it. Fix: normalize finite numeric epochs directly; finalize both received and
   applied interval checks after matching real turn/completed (or explicitly mark
   missing terminal evidence unknown), retaining thread/turn identity. No success
   coverage claim without both timestamps in the actual execution interval.

2. run-comparison.js:224-227 - Failed originalRun calls discard error.usage,
   error.execution and terminal facts although codex-app-server.js:1107-1135
   attaches them. Failed token usage is therefore excluded from budget admission
   and metrics. On successful partial usage, :218-219 also invents totals by
   zero-filling absent components and adding reasoning tokens to output tokens.
   Fix: same observation path for returned and thrown outcomes, preserve unknowns
   and raw available facts, sum authoritative totalTokens only with a separate
   known subtotal/completeness flag. Retain the original result/error unchanged.
   Reserve admission before awaiting native start so parallel pending calls
   cannot all pass the :161 turn limit before turn/started is observed.

3. run-comparison.js:232,334-343 - If startServer rejects, runtime remains null
   and retainRoot remains false, so finally deletes auth/token/root unconditionally.
   Read server.js:1616-1640: unsafe failed-start cleanup intentionally retains
   provider/state/workspace ownership and throws the original error without
   exposing a safe-cleanup receipt. Runner deletion would violate that ownership.
   Fix: mark ownership unresolved before startup; retain the private root on any
   startup rejection unless independently confirmed quiescent. Do not infer safe
   cleanup from a missing returned runtime object.

4. run-comparison.js:317-332 - Snapshot extraction, backup and runtime.close share
   one try. Any snapshot/backup error skips runtime.close, preserving a live native
   provider and HTTP runtime without attempting normal shutdown. Fix: isolate
   extraction/backup failures from a guaranteed close attempt, preserve each
   failure independently, and retain root/evidence if retention or safe close is
   unproved. Take a durable post-close backup/snapshot containing shutdown phase
   and final facts, not only integrity_check (:459). Current backup precedes close
   and deleting root otherwise discards subsequent lifecycle facts.

5. run-comparison.js:159,255-258 - Evidence pins are insufficient for matching
   inputs and actual dirty source. inputSha256 includes random per-engine
   messageId while omitting the full acceptance contract; the actual goal text
   is not retained there. The nine-file source manifest omits changing runtime
   dependencies such as delivery-contracts.js, delivery-role-service.js and
   lead-graph.js; HEAD alone cannot identify uncommitted behavior. Fix: retain
   exact semantic goal/contract and a stable semantic hash separate from transport
   envelope hash, full relevant source/dependency manifest and before/after drift
   checks, actual effective settings, and validate fixture hashes against frozen
   controls before admission. Runtime role settings already have useful capture.

6. run-comparison.js:302-310 - productHashesAfter records the immutable check but
   no comparison rejects its mutation; completed_check_passed only depends on
   task state and local exit0. A modified verify-product.js can therefore count as
   completed. Fix: require original checker hash and allowed product-only scope
   at final evaluation, alongside accepted engine/check/candidate identity. Keep
   weaker intermediate task/check status separately from full trial acceptance.

## Verified/supportable

- Ran node --check on frozen runner: pass. Independently recomputed all four
  fixture SHA-256 values: exact fixture-controls.json equality. Read actual tests:
  concrete string/numeric/invalid-input/input-preservation checks match the stated
  semantics. Same literal goal and A2A acceptance argv/id/timeout are used in both
  engines. The diagnostic is real failing product behavior, not fabricated output.
- Original onEvent and onTurnStart callbacks are forwarded and successful native
  results are returned unchanged. Observer starts steering from turn/started;
  native outputs are not substituted. Remaining timing/accounting defects above
  concern the observer evidence, not invented model failures.
- Runtime options match startServer's actual interfaces. Snapshot queries match
  inspected concurrent schemas (record_json/event_json/usage_ledger). Evidence
  payloads live in the SQLite evidence table, so an intact backup retains check
  streams. Read-only backup path is outside the disposable root.
- Private temp roots, private copied auth, CODEX_HOME set before requiring server,
  explicit runtime/storage/settings/accounts paths, loopback assertion and engine
  assertion provide the intended local isolation. Full-access execution is
  cooperative isolation, not a claim of operating-system confinement.
- Unknown ready-slot time, Legacy steering unavailability and nonrandomized case
  limitations remain honest. Startup quota check uses the actual primary limit.

Next: bounded runner repair, then re-review only the changed paths and affected
failure/receipt probes before any live dispatch. Preserve this frozen review as
history; no need to redesign the fixture or repeat existing native acceptance.

Status: complete
Scope expansion: none
