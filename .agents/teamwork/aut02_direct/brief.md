# AUT-02 direct baseline and origin repair

Current ownership authorized by lead: `docs/evidence/aut-02/replay-baseline.cjs`,
`docs/evidence/aut-02/direct-baseline.tap`, `src/a2a-role-service.js`, and
`test/a2a-role-service.test.js`. Also preserve prior scoped changes in
`test/contracts.test.js` and `test/review-policy.test.js`. The replay utility
archives `entry.json` implementationCommit to a temporary workspace, overlays
current focused tests/fixtures, and reuses current node_modules by symlink.
