# CN-03 local exit review

Review/acceptance mode in /home/sr/Projects/Workspace/codex-agent-control-plane.
Read critic TOML developer_instructions and development-access.md under
/home/sr/codex-work, project AGENTS.md, brief-cn03.md here and the current
../backlog-store/handoff.md. Source is not frozen until worker signals readiness.

Inspect actual new src/backlog-store.js, src/delivery-events.js and matching
tests directly (untracked files do not appear in git diff). No source/test/Git
mutation. Reports only under .agents/teamwork/backlog-store-review/. Disposable
DB fixtures and temp probes authorized; no live state/services/model/network.

Assess local gate, not successor runtime wiring. Check:
- Plan CAS/materialized graph equals the pure validator's approved semantics,
  including preserved historic supersession lineage and standalone edges.
- Immediate claim transaction bounds PROJECT and role capacity, pins task/settings
  identity, unique retry contexts/fences, and creates one durable intent/event.
  Clocks must not be identity sources. IDs may include colon characters.
- Pause/cancel and scheduler generation admission, immutable active contracts,
  exact external identity and stale-fence rejection. No operational setter may
  bypass the contract boundary. Expiry is recovery marking, never capacity reuse.
- Settlement state/event/capacity is one commit. Duplicate same outcome idempotent;
  conflicting terminal outcomes rejected. Quiescence/effects are explicit trusted
  facts; no absent lookup or lease inference. Check truthiness/type loopholes.
- Event append/cursors replay survive reopen and reject payload conflicts/future
  cursors; append cannot be accidentally detached from its required transaction.
- Pagination is stable/project-qualified and output bounded. Same-project multi-
  objective handling cannot multiply capacity; other projects stay independent.
- Meaningful two-connection contention and injected append rollback evidence.

Root already found timestamp-only event IDs, historical supersession replay,
objective-local project capacity, ambiguous colon IDs, and missing real settings
pin provenance before worker freeze. Verify actual fixes, do not assume reports.
Run decisive focused commands; prior unaffected137/137 need not be repeated.
Write brief.md, handoff.md, review.md; verdict APPROVE/REJECT/INCONCLUSIVE with
specific reproduction evidence. Distinguish local gate from CN-05/CN-08 integration.
