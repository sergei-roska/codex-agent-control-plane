# CN14 composition review result

Verdict: REJECT. Status: partial. Scope expansion: none.

## Blocking finding

src/concurrent-delivery-engine.js:632 requires execution.cleanupSucceeded === true in #plannerRecoveryProof, but the production AppServer never returns that property. A completed planner turn with invalid JSON becomes unknown, and even after the exact recorded process group is genuinely gone, its persisted terminal facts can never satisfy the proof. The bounded validation retry remains held indefinitely. This rejects the invalid-then-corrected planner recovery milestone; it does not indicate an unsafe retry.

Evidence (read): src/codex-app-server.js:1777-1786 executionOf returns only processIdentity, generation, threadId, turnId, turnStartSent, turnStartRejected and turnTerminal. run at :1021 attaches precisely executionOf(ctx). _cleanupTerminal at :1288-1330 performs cleanup but neither records nor exports a success flag. src/app-server-switch.js:74-77 forwards run results unchanged. No caller/adapter supplies cleanupSucceeded; rg across src finds its sole occurrence in the core proof requirement. The engine persists the returned execution unchanged at :600-603. Therefore later reopen or lifecycle proof evaluation cannot acquire the missing fact.

Evidence (ran): an inline Node vm probe extracted the actual executionOf function from src/codex-app-server.js, invoked it with terminal completed context, asserted turnTerminal true and cleanupSucceeded absent, and passed. No provider or service was invoked.

Evidence (ran): env -u NODE_TEST_CONTEXT node --test --test-name-pattern='planner-recovery|planner recovery holds uncertain host facts' test/concurrent-delivery-engine.test.js passed 5/5. Its positive fake at test/concurrent-delivery-engine.test.js:176 emits cleanupSucceeded: true and terminates its disposable fake process before return (:171); this result is not evidence that production AppServer recovery works. The negatives correctly stay held for live process, missing terminal, wrong thread and provider exception.

Fix: establish a source-backed cleanup/lifecycle contract shared by the real AppServer and engine, retain exact identity/terminal/process-quiescence checks, and test with the actual emitted execution shape. If recovery intentionally requires AppServer process exit, demonstrate the real persisted completed-turn facts becoming eligible only after that exact process is gone. Do not merely weaken unknown-effect fencing or add another fake-only marker.

## Scope and inspected context

Read current PROJECT/handoffs and critic role instructions; inspected Git status/stat and actual tracked server/launcher diff. The core/router/provider files are untracked, so read their actual contents directly. Inspected core role snapshots/provider checks, planner fact persistence/recovery joining, empty-check normalization, router intake and gate ordering, server composition/close, and provider identity helper. This was stopped on the decisive recovery contract failure as instructed. No approval is issued for remaining inherited core/host changes. No broad suite or delivery-acceptance test was run, and no excluded Git-filter evidence was reused.

Next action: repair the execution/proof contract and re-review that delta, then complete any outstanding review of the other frozen source milestones. Controls/correction/reopen/full CN14 acceptance remain pending by the brief. Source and tests were not modified; only this owned ignored report directory was written. The inline probe has no persistent artifact and is reproducible from the command in this review session.

## Exact remaining review scope

- Inherited lead role/provider mutation fix: READ ONLY, UNVERIFIED for approval. Snapshot and boundary checks were inspected, but mutation regression tests and all relevant settings paths were not independently checked in this review.
- Inherited atomic steering/replay: UNVERIFIED; not independently reviewed or run here.
- Inherited cooperative capabilities/artifact/overlap changes: UNVERIFIED; not independently reviewed or run here.
- Empty-check normalization: READ ONLY, UNVERIFIED for approval; inspected integrity-before-normalization and required-check branch, but no acceptance tests run here.
- Host symmetric durable fencing/migration/default/restart: READ ONLY, UNVERIFIED for approval; inspected tracked composition diff/router, but no focused host tests run here and fence edge paths not fully assessed.
- Provider identity/auth and host-control helpers: provider identity helper and switching return contract READ ONLY; complete helper/auth acceptance UNVERIFIED.
- The 5 focused core tests listed above are the only independent behavioral suite evidence from this review.

Root reports ordinary empty-check acceptance passed in separate scratch evidence and retry-close after release still fails. Neither was independently verified here; retry-close is outside this stopped review and remains a separate pending gate.
