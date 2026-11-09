Verdict: APPROVE
Blocking: none.
Non-blocking: This approves only narrow provider-managed cleanup evidence plumbing; cooperative release and arbitrary escaped-process quiescence remain unqualified.
Status: complete
Scope expansion: none

Candidate and integrity

Read: cleanup/brief.md, cleanup/handoff.md, cooperative decision requirements, actual git diff for the two reviewed files, and git diff --no-index against cleanup originals. The bounded candidate changes only src/codex-app-server.js and test/codex-app-server.test.js. Unrelated engine/controller changes were excluded. Existing behavioral assertions remain; the one execution deep equality was updated additively for the receipt. No test or verification was weakened.

Frozen hashes independently observed:
- src/codex-app-server.js: bb6080e83305fbc7904d4c716ec3aa1a9f2a633c64bbac4e774bdd2bd809776a
- test/codex-app-server.test.js: f65c0641a958cf4d7e2215f38c2414666bcd4cea76eb70bec2d50af13c17737a
- cleanup/source.diff: de3d7666aec32670f8803db072d292f46dfec2457ff392911d3540468415f940
- cleanup/test.diff: 809ebf1cb5ff721874682fda92f2bc25cc9a95e5343415af09fbc9175b24a178

Mechanism and compatibility

Read: src/codex-app-server.js:1288-1341 revalidates the captured App Server generation, exact child-state object and child object, live flags, and observed process identity before and after awaiting the actual cleanup RPC. Proven identity drift or generation/child replacement fails closed through the existing cleanup error/quarantine path. Missing process identity preserves prior call success but cannot mint a receipt.

Read: receipt construction at :1332-1340 occurs only after a valid existing cleanup acknowledgement (non-null object, not an array), matching original/start/pre/post process identities, child PID and nonempty thread/turn IDs. The explicit version/method/scope/completion bind it to provider-managed-background-terminals. It asserts neither process-group death, confinement, noEffect nor absence of external writes. No role report or provider-text boolean feeds the receipt.

Read: each run creates a fresh ctx at :968, and only the cleanup path assigns ctx.cleanupReceipt. executionOf at :1814-1824 exports it additively on successful return and error metadata. Normal failed terminal and abort outcomes still await cleanup, can carry a truthful confirmed cleanup receipt, and retain their original failure/abort result. Cleanup failure/timeout throws before receipt construction. A previous run's receipt is not copied into a new ctx; replacement resets the supervisor cleanup quarantine as before. Caller success/error wrapper behavior at :1015-1033 is unchanged.

Independent checks

Ran, exit 0:
env -u NODE_TEST_CONTEXT node --test --test-name-pattern='cleanup|onTurnStart runs before|routes concurrent turns|reuses a thread' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/codex-app-server.test.js

Result: 14 pass, 0 fail, 0 canceled. Evidence: review/cleanup-independent.log. The actual production adapter was driven by controlled fake JSON-RPC for held cleanup acknowledgement, exact receipt identity, RPC failure, quarantine/replacement, abort during cleanup, failed terminal, cleanup timeout, pre-cleanup generation drift, malformed response, post-await generation/process drift, missing post-await identity, concurrent turn routing and original turn-start identity.

Ran an additional in-memory direct _cleanupTerminal probe (no files/services/processes created): same-generation child object replacement after await failed without a receipt; pre-request process start-time drift failed before the RPC; missing pre-request observation preserved compatibility without a receipt; stable identity produced the receipt. All four assertions passed. This supplements, rather than replaces, the production-adapter tests.

The two known unrelated AppServer baseline failures were not rerun in a broad suite, as instructed. No acceptance/full suite or live provider was run. Logs and preserved originals are ignored local evidence and may disappear.

Decision boundary

The prerequisite resolves affirmative receipt availability and await-bound identity revalidation from the earlier cooperative decision. It does not resolve process coverage or authorize interpreting this receipt as whole-group quiescence. Future recovery must validate the explicit receipt identity/scope, retain unknown-publication/process refusals, and independently qualify the cooperative release contract.
