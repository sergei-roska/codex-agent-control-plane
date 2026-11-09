# CN14 staged terminal reconciliation implementation

Cwd /home/sr/Projects/Workspace/codex-agent-control-plane. Read/apply
/home/sr/codex-home/agents/senior_worker.toml developer instructions and
/home/sr/codex-home/development-access.md. Root owns Git/docs. Product ownership:
src/delivery-role-service.js, src/task-executor.js, src/concurrent-delivery-engine.js,
src/server.js, src/delivery-engine-router.js and their corresponding existing
*.test.js files, plus a new test/delivery-terminal-shutdown.test.js if helpful.
Do not edit other production files without reporting needed expansion first.
Scratch: this directory, worker/ subdir and worker-handoff.md. All inherited
uncommitted work must be preserved; originals/ is the exact starting snapshot.
Other workers own only new comparison/migration test files; do not edit them.
Node CommonJS, existing dependencies. Disposable local HTTP/Git/SQLite/process
fixtures allowed, no live providers/existing services/Git mutation/settings or
account changes/dependency installation. English ASCII. No quota notes.

Read decision.md: independent critic APPROVE for precise staged direction. Read
predecessor ../cn14-facade-20261028/review/cooperative-decision.md only as historical
context. Current qualified cleanupReceipt exists in CodexAppServer metadata; do
not reimplement receipt producer. Implement the chosen contract, not a design
survey. Brief purpose is ordinary cooperative safe retry-close after a lost
acknowledgement and broader terminal drain reconciliation, with truthful outcome.

Required behavior and acceptance:
1. Separate fenced drain/preparation from final reconciliation. Host and direct
engine admissions must stay closed after host shutdown starts. First held-worker
close must retain DB/workspace locks; timeout is not successful drain. Provider
close occurs only after local/provider invocations and publication/integration
callbacks drain and original eligible identities are durably captured.
2. Provider close resolution/synthetic childExited/empty survivors never proves
process quiescence. Independently bound wait/retry for original producing groups
using actual isProcessGroupGone. Preserve identities across cleared wrappers,
timeout/retry/reopen. A live group, EPERM/read error, known escaped process,
unsettled provider/publication/candidate/writer, unknown planner or pending inbox
must keep ownership. Saved close phase and concurrent close handling must prevent
overlap even when callers time out.
3. Add distinct failure-only terminal reconciliation and replay closure. Validate
exact durable contract/task/claim/fence/owner/settings/provider/request/thread/
turn/process/cleanup receipt/lane/output facts, revalidate after awaits. Same owner
only initially. Mark failed/canceled not_published without success receipt,
publication, noEffect or requeue. Preserve private bytes/original report and measured
shared workspace drift; later candidate checks must still detect that drift.
4. Preserve worktree-only noEffect recovery and strict normal resultAdapter identity.
Use store unknown/reconcileAttempt and validated terminal replay to finish missing
intent/thread/journal closure after crash. No blind reconcileAttempt twice. Do not
change store semantics unless exact failing evidence requires expansion.
5. Final unchanged lifecycle/effectsSettled guards remain sole release gate after
provider termination and reconciliation. State/HTTP/locks close only after safe
final projection. Repeated/overlapping close retries are idempotent; reopened DB
retains phase/proof and no resends. Unknown boundaries remain default deny.
6. Raw-engine correction+unsafe-shutdown+fresh-resume with only a live cleanup
receipt remains an explicit safe negative under chosen contract, not a demand to
weaken identity. Positive retirement requires same original-group-gone proof.

Tests: actual production cleanup receipt adapter with controlled fake RPC plus
disposable detached child group, ordinary cooperative held worker/lost ack first
close unsafe then terminal+group death retry safe with bytes/report/not_published,
no resend/publication, lock and DB reopen/repeated retries. Focused negatives and
crash/await boundary cases in decision.md are mandatory; prioritize exact high-risk
paths. Do not fabricate receipt-only process proof or use live test runner pid as
supposed gone producer. Source may need minimal additive host test injection for
trusted observation; defaults must use real supported process checks, no bypass.

Run focused new/changed tests with env -u NODE_TEST_CONTEXT node --test. No broad
full suite until root freeze/review. Every full/delivery-acceptance command MUST
include exact exclusion:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Never run that prohibited named test. Known baseline AppServer/legacy tests are
not green; retain named baseline distinctions. Return before scope expansion,
with concrete failing repro if a premise is wrong. Keep worker-handoff.md current,
report significant evidence and exact commands promptly. User explicitly authorized
continuing the full plan without intermediate user confirmation; root resolves
routine implementation choices and independently reviews/challenges afterward.
