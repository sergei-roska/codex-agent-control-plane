# AUT-03 cohort 3 final decision audit

Verdict: APPROVE.

## Scope

Independent read-only review of the final decision, trial entry, frozen declaration, blind scoring packet and key, scorer report, score summary, runtime/resource review, S08 qualification, S09 reuse, and mapped raw outputs. No project tests, task runs, or service actions were performed.

## Findings

- All eight blind packet outputs match the keyed raw output hashes.
- Recomputed scores are 92.85714285714286 percent for each arm, a 0 percentage-point aggregate change, and zero improved cases.
- The frozen bounded-dependencies oracle requires T0 to remain independent. The skill-on output makes T1 depend on T0, supporting the recorded mandatory-constraint hard-gate failure.
- The resource ratios meet the declared limits. S08 records both pilot-price arms blocked by the analyzer/adapter. The S09 evidence contains 22 lines and matches its recorded hash.
- The decision to keep AUT-03 default-off follows the frozen retention rules.

Non-blocking limitation: the skill-off bounded-dependencies post-task quota snapshot is missing. The final decision explicitly records that observation as unverified.

## Reviewed artifact hashes

- `trial-entry.json`: SHA-256 `f137b4e86061cb625cbc3729628ef09d65973f6a099e49f9df3b335d9cfaea3b`
- `cohort-3-final-decision.md`: SHA-256 `75ae06b8355e99b1c1bb38a68db983499931ab97ea84601667f3918860b7f590`
- `blind-scoring-packet.json`: SHA-256 `ac60b78dcb31c8738aed804f2b3e8d465de9d6a4a2cf072a0ea987e069b4d028`
- `blind-scoring-key.json`: SHA-256 `f34748748deb75d4e5ac9d4f647c7097a6be6010a6d9a7eb4419609c6d239837`
- `cohort-3-blind-score-summary.json`: SHA-256 `a4032f026a2e8de95dd8bbd11ef92c9d9349b180eb86cb28ab6182238171db1b`
- `cohort-3-runtime-resource-review.md`: SHA-256 `96c99712f1a356ecb67a01519836274cb636a50ae35108b32c3a0fb1e0ce424e`
