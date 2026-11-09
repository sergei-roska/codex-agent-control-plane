# Independent admission and runtime review

Status: APPROVE for both components. Runtime activation pending graph regression
investigation. Reports recorded by root; critic and runtime worker could not
create their coordination directories in their environments.

Initial admission REJECT: an existing-checkpoint writer in an earlier execution
group could co-dispatch with a new prerequisite verifier. Fixed by rejecting
every other writable assignment during new prerequisite admission. Regression
covers original checkpoint writer wave 1 followed by linked verifier wave 2.

Re-review: exact pending checkpoint linkage, known target, immutable scope,
verifier-before-auditor and finish gates remain enforced. Critic graph 3/3,
full contracts 46/46, diff check passed. Two previous contracts error-message
assertions were already stale at HEAD; worker aligned them while preserving
rejection assertions.

Runtime: GET /control/runtime uses existing bearer middleware. Frozen module-load
snapshot contains pid, time, startup Git revision, loaded source hashes and
explicit uncaptured files; no token. Only designated CommonJS sources are
intercepted; other files use the original loader. Sealing and target compilation
failure restore the original loader. Critic runtime tests 2/2 and custom-loader
delegation/restoration probe passed. Root final full server tests 80/80 outside
network sandbox.

Runtime limitations: server.js is a synchronous module-entry disk snapshot;
imported controlling sources are hashed from bytes immediately before compilation.
Startup Git revision identifies HEAD, while source hashes identify dirty loaded
content. Designated target modules bypass preexisting custom transform hooks;
this production CommonJS setup has no such hook shown.

Expanded graph command in worker environment returned a wrapper failure without
nested evidence after 59.9 seconds. Root is collecting direct graph results in
/tmp/h29-lead-graph-tests.log (temporary), without changing expectations.
