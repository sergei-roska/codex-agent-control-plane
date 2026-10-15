# Pilot Price Repair Plan

Status: candidate; lead acceptance pending.

## Scope

The only product write is `product/src/price.js`. Product tests, `product/CHECKS.json`, and `product/package.json` are protected. The verifier operational scope is the separate `verification/checks/` directory; it does not authorize product edits.

## Check

The planned check is `npm --prefix product test` with a 60000 ms timeout. This is a plan only. The offline context/map validator never executes commands.

## Risk and review

The feature is a routine arithmetic repair with explicitly reviewed empty risk tags. Independent context review and lead acceptance are pending.
