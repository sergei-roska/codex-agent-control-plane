# AUT-03 case review

Status: APPROVE. The frozen synthetic case set is suitable for a later
authorized paired trial. It is not a baseline and does not authorize live
model calls.

The independent reviewer checked all 11 manifest references, ASCII bytes,
case dependencies, and the accepted AUT-01 F2 reference. All hashes matched;
the four listed full task orders satisfy the graph. T0 is independent of the
T1-T2-T3 chain. A1 remains blocked until a source-backed report-page
integration point is identified. The bounded-dependencies oracle includes R4
regression coverage. The owner-decision and contradictory-source cases retain
their blockers. The accepted F2 anchor is reference-only.

The review loop resolved three findings before approval:

1. The first version marked the report-page integration task ready without a
   source-backed integration point and omitted R4 regression coverage. The
   revised case blocks A1 and names the existing report-view and JSON endpoint
   regression tests.
2. The revised graph incorrectly made the independent T1 serializer task wait
   for T0 integration discovery. T0 is now independent; T1-T2-T3 remain
   ordered.
3. The test command was changed to the repository's actual `npm test` script.

Evidence: `.agents/teamwork/aut-03-oracle-cases/handoff.md`. The final
independent verdict was APPROVE with no blockers. No product tests, model calls,
baseline capture, or service actions were performed for this review.

The reviewed manifest status now records that approval. Its final SHA-256 is
`62965a3048628359227bf762891a1bd2988f3cfa77588c0c579a3e5624b1a756`; the
case inputs and oracles are unchanged. Baseline capture remains prohibited
until separately authorized trial conditions are declared.
