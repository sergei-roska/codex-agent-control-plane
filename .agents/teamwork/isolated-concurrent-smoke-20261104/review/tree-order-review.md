# Measured review tree ordering delta

Verdict: APPROVE source delta. Operational same-task resume remains a separate pending review.

Read: treeManifest now sorts measured entries by complete relative path using explicit < and > comparison before digest. This is equivalent to CandidateStore.captureManifest's global default full-path sort, unlike sorted directory traversal. It fixes patches.lock.json preceding patches/a.patch without altering stored expected manifest, bytes, mode, digest shape, materialization, symlink/special-file refusal or drift gates. Prior large-scope approval remains valid for the unchanged compaction helper.

Read regression: fixture contains the exact mixed file/directory prefix case and checks captured expected ordering, successful real prepareReviewInput plus verifyReviewInput, then independent content, executable-mode, extra-file and missing-file tampering rejection on fresh materializations. No assertion is weakened and no mismatch is normalized away beyond measured ordering.

Read source SHA-256: d8a1c822fbc68813dbea7993814d5c49a8264cb99c76db842786650e60a85caf. git diff --check passes. Worker reports 29/29 candidate-review tests; broad full-tree-order.tap was running at dispatch. No redundant suite, provider call, runtime DB access or frozen-file edit performed.

Status: complete for narrow source delta.
Scope expansion: none
