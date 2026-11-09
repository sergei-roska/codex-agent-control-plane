# Admission barrier handoff

Implemented the project-wide provider admission gate primitive in
`src/app-server-switch.js`. Gate acquisition closes admission before awaiting
active calls, and resolves after the tracked count drains. Tracked App Server
methods and pass-through reads share the gate; synchronous pass-through return
behavior is preserved. Only the exact live token can switch while gated or
release the gate. Close blocks admission, drains work, invalidates a pending or
live token, and closes the instance. Existing selection CAS and rollback paths
remain in place.

Changed files: `src/app-server-switch.js`, `test/app-server-switch.test.js`,
this handoff.

Verification:
- `node --test test/app-server-switch.test.js` - 22 passed, 0 failed.
- `git diff --check` - passed.

This is the wrapper primitive only. Durable transition journal, engine rebind,
server recovery, and composition remain outstanding. The inherited
`:memory:.lockdb` and Git state were left untouched.
