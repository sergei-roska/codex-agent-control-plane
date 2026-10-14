# ADR: Bounded prerequisite review across pending critical checkpoints

Status: accepted.

A critical review gate can block an independent review of a newly defined
prerequisite contract. The controller admits one new gated verifier checkpoint
when `review.prerequisiteFor` names the exact complete set of currently incomplete
critical checkpoint IDs. The list is bounded by the existing review contract.
Ordinary review contexts use an empty list; legacy contexts omit the field.

The new checkpoint must have a known scoped target and a new checkpoint ID.
Its decision cannot contain another writable assignment. A matching read-only
auditor may follow the verifier in a later execution group, or in a later
decision after a passing current-target verifier receipt. Both reviewers repeat
the complete immutable review context, including `prerequisiteFor`.

Admission registers a separate review obligation. Its results create actual
run-bound receipts through the ordinary review path. It does not accept or remove
any original obligation. Unrelated writers and finish remain blocked until their
required current-target receipts exist. Unknown or changed targets, mismatched
links and same-decision writers are rejected.

The bearer-authenticated `GET /control/runtime` endpoint reports an immutable
module-load snapshot: process ID, timestamp, checkout HEAD, source SHA256 values,
and explicitly uncaptured source files. Imported controlling CommonJS modules
are hashed from the bytes compiled. The server entry module uses a synchronous
module-entry disk snapshot. Checkout HEAD alone does not identify dirty loaded
content. Cached modules are not attributed hashes from subsequent disk reads.

The temporary source capture delegates non-target modules to Node's loader.
Designated target modules bypass custom loader transforms; this controller uses
ordinary CommonJS loading. Service activation requires a managed server restart
after existing workers have stopped, followed by checking the returned source
hashes against the reviewed implementation.
