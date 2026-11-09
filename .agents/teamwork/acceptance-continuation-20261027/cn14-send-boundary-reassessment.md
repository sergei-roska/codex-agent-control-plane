# Scoped send-boundary reassessment

After the earlier capability correction, the challenger reproduced one remaining
TOCTOU: the scoped check runs before the trusted onTurnStart callback, which can
synchronously apply owner pause before turn/start is actually written. A late
failure prevents receipt acceptance but still starts a disallowed model turn.

The invariant belongs at the actual write boundary, not merely before setup or
callbacks. Existing _request supports synchronous onSending immediately before
_write, with onWriteError resetting turnStartSent=false. Revalidate the scoped
claim/control/candidate inside turn/start onSending before marking sent. No await
or callback with external side effects may intervene between this validation and
_write. Preserve initial/pre-thread checks and all legacy behavior. Denial must
report explicit no-send and leave no timer/run reservation accidentally active.

Add the challenger's exact onTurnStart pause interleaving to the permanent scoped
integration suite. One created provider thread is harmless; zero turn/start writes
and no receipt are required. Existing targeted source tests plus this probe and
independent delta re-review are sufficient; do not repeat unrelated baseline work.
