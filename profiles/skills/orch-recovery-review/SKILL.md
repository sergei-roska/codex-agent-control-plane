---
name: orch-recovery-review
description: Audit an orchestrator's failure, retry, restart, stale-result, approval, and output-integration behavior against concrete scenarios.
---

# Recovery Review

Use for a targeted reliability review or before accepting a change to dispatch, execution, verification, integration, or approval flow. Read sections 6-12 and 14 of `.codex/orch/REFERENCE.md` as relevant.

1. Map authoritative state and every boundary crossed by the changed flow. Locate the exact claim, dispatch, result acceptance, capacity release, verification, integration, and approval transitions.
2. Trace concrete scenarios: duplicate delivery, lost acknowledgment, worker crash, expired lease with late result, invalid output, retry exhaustion, cancellation, changed plan revision, and conflicting outputs. Select only scenarios applicable to the product.
3. For each scenario, identify the persisted state before failure, the recovery action, the invariant that prevents corruption, and the observable evidence.
4. Check that required permissions and human decisions bind to the exact action and revision. Treat model verdicts as evidence, not as authorization or mechanical verification.
5. Report findings by severity with file and line evidence, reproducible steps or a focused test proposal, and the residual risk. Clearly separate verified behavior from inference.

Avoid requiring distributed mechanisms for a local single-process product unless a concrete failure case justifies them.
