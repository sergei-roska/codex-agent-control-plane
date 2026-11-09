# V14 initial planner contention delta review

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

Read current #advance and deterministic restart fixture against the previously
reviewed frozen source. Removing only the new exact line in memory reproduces
SHA-256 c62538436b71fb68a88a216f03152fc72c30f122c522d29345c782f875ed1975,
proving the production delta is solely the inbox wake guard. No speculative
scheduler.inFlight workaround or other production change remains. Five other V14
production hashes and the store test hash match the earlier approved delta.

Read: #advance now returns on controller.inbox.projection().wakeup immediately
after awaited owner correction synchronization, before candidate projection,
automatic review creation, plan revision mutation or controller shutdown.
LeadPlanner preserves its inbox trigger when another objective holds the project's
reserved planner slot. Consequently automatic verifier planning cannot increment
a fresh run's planRevision while its initial lead turn is still pending. The
existing store finalization inbox guard alone covered commit, not earlier automatic
review-plan mutation. This repair closes that earlier ordering window.

Read/ran: regression holds the corrected first objective's real planner invocation
in the reserved slot, starts a fresh second run, observes busy planner plus pending
initial wake, and requires planRevision0 with zero tasks. After release it requires
the investigated owner decision, closes/reconstructs the real host and SQLite while
that same run is waiting, preserves exact request/pins and zero provider resend,
then authenticates its answer and requires verifier, mandatory check, accepted
candidate and durable finalization. All earlier acceptance/replacement checks
remain substantive. The worker's before-fix observation is retained as its evidence;
this reviewer independently ran the corrected assertions below.

Independent commands, both exit0:

    env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/owner-decision.test.js test/owner-decision-restart.test.js

PASS20 FAIL0 SKIP0; race-delta.tap.

    env -u NODE_TEST_CONTEXT node --test --test-reporter=tap --test-name-pattern='owner correction facade' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/concurrent-delivery-engine.test.js

PASS7 FAIL0 SKIP0; race-correction.tap.

Stable reviewed hashes before/after checks:

    2127846c213efa5db796fb615656a6ffa3db8c70a5cd874eceefa72c3e238949 src/concurrent-delivery-engine.js
    a6b83625173e10556ef8657f4efd903d3f8371570658f00854ba15c78243bb1d test/owner-decision-restart.test.js

Earlier delta.md hashes remain current for the other reviewed files. No reviewed
source/test/docs or Git edits, broad suites, live providers/services/settings or
installs. Logs are ignored scratch and may disappear. This bounded delta approval
does not replace repaired frozen affected/full checks or final matrix acceptance.

Pitfall: Finalization commit guards cannot prevent an earlier automatic review
plan from overtaking a pending initial planner turn; fence that mutation too.
