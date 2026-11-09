# Accepted review recurrence repair

Repair the Harness verifier/auditor recurrence guard so a newly integrated, exact-attempt accepted receipt for the current target resolves the prior failure recurrence. Preserve genuine repeated-failure termination, receipt freshness, candidate binding, and service review validation. Do not edit target project source, restart services, mutate Git, or call models.

Evidence supplied by lead: followup e2c71938-b92f-4b70-a231-dc0088343016 recorded failed verifier attempt r1, stale-origin verifier r2, and accepted current-target verifier r3. The r3 `review_result` was accepted with `currentTargetMatches=true`; the run nevertheless emitted a no-progress partial for 3 attempts. The recurrence guard counted every verifier attempt without considering the graph-owned accepted receipt.
