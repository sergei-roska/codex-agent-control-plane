# Process cleanup challenger report

Verdict: HOLDS
Status: complete
Scope expansion: none

Probe: `/tmp/process-cleanup-challenge-20261019.js`
Command: `node /tmp/process-cleanup-challenge-20261019.js`
Result: exit 0. Output:

```
PASS real child isolation: finished exits, active remains alive until terminal
PASS 75 assignments: 75 clean RPCs, zero live owned children
PASS cleanup failure blocks later read-only turn before model start
PASS replacement generation remains unblocked by late old-generation failure record
PASS late abort remains canceled after cleanup and owned child exits
FINAL owned=81 alive=0
```

The probe instantiates the changed `CodexAppServer` with a disposable JSON-RPC child stub. The stub starts real owned `sleep 120` OS child processes on `turn/start`, terminates only the requested thread's process on `thread/backgroundTerminals/clean`, and reports confirmed terminal notifications. A completed thread's child exits while a distinct active thread's child remains alive. Seventy-five sequential assignments produce 75 cleanup requests and zero live owned children. A failed cleanup quarantines a subsequent read-only role before `turn/start`. After a simulated server generation replacement, replaying an old-generation failure record does not block new turns. An abort during delayed cleanup waits for acknowledgment, then yields `AbortError` and zero live owned children. The script kills any remaining child it owns in its `finally` block.

Limitation: this probes the changed client lifecycle and real OS child process fate behind a controlled RPC stub. It does not prove that installed Codex registers a terminal started by `thread/shellCommand` or that its native `clean` RPC terminates one. No model inference, live Harness service, database, or network service was used.

The setup-admission race identified by the separate critic is excluded from this verdict; the worker repaired it independently. The final run above used the repaired source. The generation probe directly replays an old failure record through `_recordCleanupFailure`; it does not simulate a network-late native RPC response.
