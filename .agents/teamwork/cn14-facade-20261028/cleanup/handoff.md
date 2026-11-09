# Cleanup receipt source freeze

Changed only src/codex-app-server.js and test/codex-app-server.test.js. The version 1 receipt confirms only provider-managed background terminal cleanup; it binds the method, thread, turn, generation and observed process identity. Generation/child/process drift fails closed; missing identity preserves legacy success without a receipt. Failure and abort outcomes retain confirmed cleanup metadata. No cooperative release changes.

Frozen SHA256: source bb6080e83305fbc7904d4c716ec3aa1a9f2a633c64bbac4e774bdd2bd809776a; test f65c0641a958cf4d7e2215f38c2414666bcd4cea76eb70bec2d50af13c17737a. Relative to originals, source.diff SHA256 de3d7666aec32670f8803db072d292f46dfec2457ff392911d3540468415f940; test.diff 809ebf1cb5ff721874682fda92f2bc25cc9a95e5343415af09fbc9175b24a178. Originals and logs are local ignored scratch and may disappear.

Before and after: node --test --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/codex-app-server.test.js. Before 117 pass, 2 fail; after 123 pass, 2 fail. Same inherited failures: enumeration failure still sends apps/plugins/skills overrides and marks enforced false; selected skills are explicit turn inputs with scoped boundary and hash provenance. See before.log and after.log.

Targeted: node --test --test-name-pattern='cleanup|onTurnStart runs before' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/codex-app-server.test.js: 13 pass, 0 fail. git diff --check -- src/codex-app-server.js test/codex-app-server.test.js: pass.

Next: independent critic and adversarial review. No self-acceptance or broader process-coverage claim.
