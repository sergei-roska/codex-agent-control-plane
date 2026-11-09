# Backend review: safe explicit Concurrent resume

Verdict: APPROVE
Blocking: none
Status: complete
Scope expansion: none

## Acceptance evidence

- PASS, read and ran: provider-drifted quiescent paused objective is classified dormant during startup without preparing a new thread or resuming. Genuine unknown historical planner state returns unknown, preserving server.js's any-unknown global fence.
- PASS, read and ran: explicit resume prepares a fresh current-provider planner thread. After prepare, current provider and role settings are checked; the transaction rechecks current eligibility, inbox version, owner generation/control revision/disposition, and exact original raw persisted lead binding. Owner-control and raw-binding race tests refuse without archiving or rebinding.
- PASS, read and ran: old binding is durably archived in planner.provider_rebound in the same transaction as CAS binding update and revisioned objective transition. Historical planner ledger, checkpoint and attempt data remain intact.
- PASS, read and ran: blocked_technical recovery requires the queued registered frozen verifier, known candidate, exact canceled undispatched-review no-effect receipt and terminal digest, contract digest, released claim/fence/generation, plus no unresolved attempts/claims/effects/retries/owner controls. Store rechecks its owned facts and emits objective.resumed with one control revision advance.
- PASS, read and ran: integration resumes the exact frozen verifier and reaches accepted host finalization. Historical checkpoint profile pins remain immutable. Historical profile substitution changes account/home only, preserving current nonidentity verifier settings, and requires a contiguous same-run/objective durable rebind lineage ending at the persisted current planner binding. Semantic verifier-setting drift, tampered lineage and unrelated lineage all refuse finalization; checkpoints remain unchanged.
- PASS, read: surrounding caller, controller/planner, inbox, scheduler and server recovery fence behavior inspected; source/tests contain no removed verification, swallowed safety errors, production hardcoding or weakened assertions in the scoped delta.

## Independent verification

Ran:
node --test --test-name-pattern='provider drift stays dormant|provider rebind refuses|provider drift resumes a blocked objective|provider rebound finalization rejects|blocked technical resume requires|owner pause facade resume preserves technical boundary' test/concurrent-delivery-engine.test.js test/backlog-store.test.js

Result: 15 passed, 0 failed, exit0. Evidence final-focused.tap (local ignored evidence). Root owns affected broad suites and live acceptance; no duplicate broad run performed here.

Frozen SHA256 hashes confirmed before/after:
- src/concurrent-delivery-engine.js: 2b9d988ba49fb26b50eb4ae8516a2ee7edd4e63e985e83ab22583c6cce5b79e2
- src/backlog-store.js: 56e5f3311a402498b32b28fd53adb112b1cde2bd394a5768f081181c9634ce2e
- test/concurrent-delivery-engine.test.js: 08ebec27995d6a16507fb671f3333a0871c3549e90ce88b8b613d66e577d628a
- test/backlog-store.test.js: e1a847839592ab1c53ed045bc43fcf2cff08fdbecea5b68ce649242f4b576ab8

Reviewed source/test deltas against the named task baselines, including the corrected store task materialization and finalization lineage additions. Earlier partial run findings are superseded by this frozen verification. UI approval remains separate at ../review-ui/rereview.md.

## Boundary

This approves the frozen backend repair and its deterministic acceptance path. No live startup, account switch, task submission, database mutation or full live delivery acceptance was performed by critic. Root retains runtime reload and actual UI continuation/state-preservation acceptance.

Pitfall: A provider identity transition must preserve historical checkpoint semantics as well as historical execution identity; a fresh planner alone does not establish finalization compatibility.
