# CN14 host follow-up handoff

First bounded milestone ready for independent review. Changed src/server.js and
its dedicated test/server-delivery-engine.test.js only. Other owned source is
unchanged from inherited server composition; core/UI/other workers untouched.

Server startup now rejects unknown persisted engine selection with typed
 delivery_engine_selection_unsafe before provider identity or concurrent work.
Mapping is preserved. Real default server/router/core startup tests reopen durable
SQLite after switching concurrent-v1 default to legacy. Executing objectives block
legacy as busy; terminal objectives with mixed released/unknown or active claims,
and mixed settled/unknown or pending publications block as unsafe. Fully settled
rows permit legacy. Tests retain stored concurrent mappings. Symmetric legacy busy
fence and independent projects are exercised through actual server composition.
Fixtures seed recovery rows intentionally; they do not claim ordinary acceptance.

Verification: env -u NODE_TEST_CONTEXT node --test
 test/delivery-engine-router.test.js test/server-delivery-engine.test.js
 test/delivery-host-controls.test.js test/delivery-provider-identity.test.js
Passed33/33, failed0. Disposable Git/SQLite/fake AppServer only. Initial fixture
failures were missing fake capabilities, invalid digest fixtures, and omitted
SDK call context; corrected against actual interfaces before passing assertions.

Pending: independent milestone review; core worker notice before acceptance or
safe close continuation. Existing authenticated steer fixture proves unsafe close
retains locks but still has pending inbox and does not prove successful retry.
Next: exercise ordinary real acceptance and safe retry-close after core stabilizes.

Follow-up preparation: acceptance-draft.cjs in this ignored directory contains
syntax-checked, not yet executed real default server empty-check acceptance and
held engineer unsafe-close/safe retry fixtures. Product source/tests frozen for
lead review. Await stable-core notice before running these drafts. Scratch imports
use absolute repository paths and require NODE_PATH=$PWD/node_modules when run
from this ignored directory. node --check acceptance-draft.cjs passed.

Core stable follow-up: added actual real default server empty-owner-check
acceptance to dedicated product test file. Fixture uses real router/core/service,
fake AppServer and disposable Git/SQLite/HTTP; coordinator returns no plan delta,
verifier checks the frozen candidate, disposition accepted and A2A completed.
Existing fixture helper now accepts fake provider overrides and starts local HTTP.
Focused new/restart cases10/10; full host command above now34/34. Output retained
host-suite.log. git diff --check passed. Source files remain frozen for critic.

Safe retry-close remains blocked, with minimal repro in acceptance-draft.cjs
(second test). acceptance-draft.log:1 pass/1 fail. Diagnostic-only rerun captures
close-diagnostic.log (1 fail). First close correctly retains open DB/workspace
lock; after releasing held engineer, RoleService becomes terminal/effectsSettled
true but backlog attempt remains claimed/externalTaskId null/release_facts null,
and claim active. Projection canceled, inboxPending0. Executor evidence says
send_uncertain AbortError and cancel_uncertain HTTP503 shutting_down. No pending
inbox bypass or source edit. Root/core worker/critic notified. Core inspection
suggests shutdown does not reconcile terminal role calls after draining. This is
not yet established as the complete fix; root coordinates source changes.

Critic delta correction (source frozen for re-review): src/server.js now validates
mapped project/objective/session IDs against run and objective records; unknown,
active or unrecognized exact project/session planner ledger state is unsafe even
without a controller fence. Terminal planner states complete/stale/reconciled_no_effect
permit admission. Foreign project and unrelated session ledgers do not leak fences.
Also rejects authoritative candidate_intents outside applied/refused/not_applied,
and role execution rows without exact identity, terminal/settled state and boolean
true effectsSettled. No source changes outside assigned server.js.

Before authoritative guard, real restart matrix reproduced seven unsafe admissions
(candidate prepared/applying/unknown/settling and role unknown or terminal false/
missing effectsSettled); four settled positive cases passed. Output
 authoritative-effects-before.log reports4 pass/8 fail including parent failure.
After correction, full dedicated host command above passed61/61 (0 failures),
node --check src/server.js and git diff --check passed. Output
 host-correction-suite.log. Added mapping/run/objective identity negatives and exact
project/session positive isolation cases. Existing empty-check acceptance remains green.

Core all-stored-runs shutdown safety correctly invalidated old test cleanup that
closed fabricated unresolved data as if safe. Restart faults now seeded only after
closing idle server; final teardown explicitly removes only fabricated stored run
rows after all refusal/mapping/ledger assertions. This cleanup does not qualify safe
production shutdown. Safe retry-close scratch has not been rerun unchanged.

Remaining scope question sent to root: publication cache applied/not_applied without
any authoritative intent is not yet rejected by current host bridge check. Actual
projectPublication treats missing authoritative intent as unknown except refused.
Potential correction needs settled-positive fixture rows upgraded accordingly.

Final host correction freeze: full dedicated host command passed70/70, failed0.
node --check src/server.js and git diff --check passed. Exact output is retained
host-correction-suite.log. No further source/test changes pending in this worker.

Missing authoritative publication case now corrected: cached applied/not_applied
requires an authoritative CandidateStore intent with matching intent ID and exact
mapped project/objective identity, plus known terminal effect state. Missing intent
is allowed only for refused cache per projectPublication contract. Real restart
regressions reject missing intent and wrong intent ID/project/objective, preserve
mapping/intake refusal, and permit matching applied/not_applied and refused without
intent. Synthetic positive intent rows now use actual CandidateStore-created base
and child candidates plus frozen manifests and matching identity, not cache-only
classification. Root requested this final narrow scope; all source outside server.js
remains unchanged by this worker.

Supersedes previous remaining scope question: resolved above. Root/critic delta
re-review is next. Successful held-engineer retry-close remains explicitly pending;
unchanged failing scratch was not rerun. Unknown pending inbox safety remains intact.
