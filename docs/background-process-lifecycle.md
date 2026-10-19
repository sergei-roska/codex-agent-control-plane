# Background process lifecycle

Agent tool terminals belong to the assignment's Codex thread. They may remain
running while a turn executes, but must not accumulate after that turn ends.
This includes test commands whose execution handle was lost in a tool wrapper.

## Completion boundary

After a confirmed completed, failed or interrupted turn, the client calls
`thread/backgroundTerminals/clean` for that thread before returning the turn's
result or error. A2A writer settlement and lane integration therefore happen
after the cleanup acknowledgement. The client retains its in-flight thread
entry until cleanup finishes, so a new turn cannot overtake the cleanup of the
same thread. Other threads continue on the shared App Server.

The cleanup call uses its own bounded timeout, independent of the caller's
aborted signal. Thread history remains available for continuation. Background
tool processes do not carry over into the next assignment/continuation; an
agent must start a needed command again.

The client negotiates `capabilities.experimentalApi` during initialization.
The installed protocol schema and the official
[background terminal API](https://learn.chatgpt.com/docs/app-server#clean-background-terminals)
define this per-thread operation. It does not require an inference request.

## Failure handling

If cleanup fails, is unsupported or times out, the client reports
`background_terminal_cleanup_failed` and preserves the model's original turn
outcome separately. A confirmed model terminal does not prove that background
writers have stopped. Resource quiescence remains unknown, preventing normal
writer settlement and lane integration until reconciliation establishes safety.

The same App Server generation is also quarantined for new model turns. This
prevents repeated read-only or Lead assignments from creating more terminals
when cleanup remains unavailable. Already active threads can finish and run
their own cleanup; no shared process is killed to enforce quarantine. A new
supervised App Server generation clears this admission block. A delayed failure
from an older generation cannot quarantine its replacement.

Cleanup is tied to the original thread and App Server generation. A rejected
turn start or an unconfirmed terminal must not cause cleanup of another active
thread or a replacement generation. Existing process-failure reconciliation
continues to handle unknown turns and failed App Server generations.

Per-thread cleanup does not terminate the shared App Server, archive the thread,
or kill host processes selected by command name or working directory. This
policy covers terminals managed by Codex; separately managed project services
retain their own service lifecycle.

## Applying the change

Existing Node processes retain the client code they loaded at startup. Loading
the new lifecycle requires a managed project-server restart at a safe boundary.
Use the supported soft pause, wait for the active assignment to finish, restart
the managed project, and resume only a pause created for this maintenance.
Preserve pre-existing owner pauses and open owner decisions.

## Verification

The focused cleanup and concurrency tests pass, including an admission race
where another thread fails cleanup during awaited setup. Independent review
approved the corrected implementation. A disposable RPC probe used 81 real
owned child processes: it verified neighbor isolation, 75 sequential assignments
without survivors, failed-cleanup quarantine, generation replacement and late
cancellation. All owned probe children exited.

The installed Codex protocol accepted list/clean on a disposable empty thread
without model inference. The real-child probe uses a controlled RPC stub; it
does not separately establish native terminal registration. Five failures in
the broader existing suites reproduce with the same messages on the unchanged
HEAD baseline. They are not counted as passing checks.
