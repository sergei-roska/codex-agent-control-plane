# AD-04/AD-05 diagnosis and effect-control

Status: source map complete; implementation not started.

## Ownership and next action

Luna explorer completed the map in `map.md`. Legacy AD-04 still turns repeated
work into technical partial outcomes; AD-05 has conservative effect fences but
no general automatic reconciliation when an external dependency recovers.
Concurrent AD-04 retry-policy work and AD-05 lifecycle wake work share
`src/delivery-lifecycle.js` and must be serialized. The lead will assign them
after active shared-file owners finish.

## Verification

No AD-04/05 checks have run in this work cycle. No live provider/quota
operations are in scope.
