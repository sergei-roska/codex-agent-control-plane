# Cooperative held-worker recovery context

## Refusal path (read)

- `src/concurrent-delivery-engine.js:400-415`: shutdown retries every nonterminal durable attempt by `prepareNoPublicationRecovery`, then `requestLifecycleRecovery` and `executor.recover`. A refused prepare silently leaves the attempt untouched; shutdown projection later rejects release.
- `src/delivery-role-service.js:253-326`: recovery snapshot requires a terminal settled role execution, provider invocation started, completed terminal status, matching attempt/claim/executor identity, stable provider/settings/contract pins, terminal turn receipt plus process identity, and no candidate/publication side effects. Crucially, when a role has a lane, lines 303-322 require `this.lanes.mode === 'worktree'`; cooperative mode always fails. With product write paths, lane-less fallback also fails. This is the direct ordinary cooperative refusal.
- `src/task-executor.js:395-430`: recovery proof must be synchronous, exact-identity matched, and explicitly set `noEffect`, `remoteQuiescent`, `processQuiescent`, `effectsSettled` true. On refusal it records evidence and leaves the attempt unknown; there is no ordinary completed-result settlement path after send acknowledgement abort.
- `src/concurrent-delivery-engine.js:1093-1105`: final release additionally requires zero open attempts and no unresolved role/publication/candidate/writer records.

## Available evidence and limits (read)

- `src/delivery-role-service.js:595-609,625-638`: production RoleService persists returned provider execution, thread/turn IDs, terminal status, and marks `effectsSettled` from `turnTerminal` (or explicit no-start/rejected/known terminal error). It does not persist a separate process-group-gone observation here.
- `src/delivery-role-service.js:290-296,323-325`: recovery validates `turnTerminal`, start receipt and process identity (PID/PGID/start time), but identity is not evidence that the process group is now absent. `src/process-quiescence.js:62-75` offers `isProcessGroupGone` for that stronger check; the recovery snapshot does not call it.
- `src/delivery-role-service.js:607` treats a terminal provider turn as effects settled at the provider-execution layer. That says the turn terminated, not that cooperative commands stayed in the private lane or caused no writes. `src/writer-lanes.js:282-287,362-370` explicitly reports cooperative confinement as `none`, warns the worktree is not a security boundary, and gives it no sandbox policy.
- Diagnostic fixture evidence: `.agents/teamwork/cn14-host-followup-20261027b/close-diagnostic.log:52-85` shows the retried RoleService record terminal/effectsSettled true, but host attempt remained claimed, claim active, `externalTaskId` and `release_facts` null; initial executor send was `AbortError`, cancellation was HTTP 503 `shutting_down`. This rules out inbox-pending as the remaining blocker and shows the executor never reconciled the provider's terminal result.

## Safe settlement question and narrow paths (hypothesis)

An ordinary successful/terminal provider completion could potentially close the shutdown attempt without asserting `noEffect`, because completion is known and cooperative writes may have occurred. It must not be mapped to recovered-no-effect: `BacklogStore.settleRecoveredNoEffect` requires `noEffect=true` (`src/backlog-store.js:1143-1152`) and records settled no-effect facts. A distinct truthful terminal-outcome settlement path would need to preserve potential writes/publication as unknown and keep final release fenced unless publication effects are independently resolved. For this canceled shutdown repro there is no safely inferable successful delivery outcome from current evidence: the role report is in its terminal record, but abort lost the executor acknowledgement and no host attempt result/release facts exist.

Smallest options/tradeoffs:

1. Narrow the recovery snapshot to allow cooperative lanes only after recorded terminal turn plus independent process-group quiescence, and settle as an explicit unknown-effects terminal failure rather than no-effect. This can retire the claim only if lifecycle semantics can retain publication uncertainty without release; likely does not make shutdown safe while writes/publication remain unknown.
2. Add a separate ordinary terminal-result reconciliation path using the persisted RoleService result/report and exact pins, then route through normal scheduler settlement. This preserves known completion semantics but must not use the no-effect recovery API; publication still needs its own refusal if it is uncertain.
3. Keep refusal. Safest and smallest until a truthful cooperative process/write-effects contract exists; does not fix ordinary retry-close.

Unknown provider state remains a hard refusal: `delivery-role-service.js:253-257,290-296` requires provider terminal receipt. Unknown publication must remain refused: recovery snapshot rejects existing publication/candidate intents (`:297-302`), and engine shutdown checks unresolved publication/candidate states (`concurrent-delivery-engine.js:1098-1102`).

## Decisive fixture

`.agents/teamwork/cn14-host-followup-20261027b/acceptance-draft.cjs:145+` is the real-default-server held engineer close/retry fixture; its prior diagnostic output is `close-diagnostic.log`. The held engineer returns a terminal completed fake provider result after unsafe close, then retries `runtime.close()`. Current failed run demonstrates the refusal; any positive qualification must assert lock release only with truthful terminal/process/publication semantics, and retain separate unknown-provider and unknown-publication refusal fixtures. No tests run for this map.
