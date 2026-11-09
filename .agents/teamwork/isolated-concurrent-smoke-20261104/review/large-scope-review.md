# Lossless frozen read-scope compaction review

Verdict: APPROVE source delta. Continued native target acceptance remains unverified.

Read actual diff: compactKnownReadScope checks every attested selected leaf against the same pinned candidate manifest, including normalized digest equality. The full closure and its digest remain unchanged in contextCore. Only task.readScope.paths receives compact output. Scopes of at most 500 leaves preserve their existing leaf list; 500 is the actual delivery-contracts.js pathArray limit, distinct from the generic 1000 JSON item bound.

For larger sets, a segment trie counts all manifest leaves and selected leaves. Only a non-root node whose selected count equals its complete manifest leaf count collapses to a prefix. Traversal stops under collapsed nodes, yielding an antichain. Exact segment-prefix coverage is rechecked against every manifest leaf; partial siblings and similarly named directories cannot widen scope. Ordering is deterministic for the normalized closure/local runtime. Absent/mismatched selected leaves and unrepresentable sets fail before review context/task insertion. No root wildcard, truncation, limit increase or unknown fallback is introduced. Candidate materialization and complete-tree drift verification remain unchanged.

Ran independent checks:
- node --test --test-name-pattern='large known closures|large sparse read scopes|known closures must match' test/candidate-review.test.js: 8 pass, zero fail. Evidence: large-scope-focused.tap.
- Evaluated the exact source helper in an isolated function with real fail/digestValue dependencies and normalized closure digests: 500 nested leaves unchanged, 501 nested leaves losslessly collapse to one directory, 500 top-level leaves unchanged, 501 top-level leaves explicitly refused. Evidence: large-scope-boundary.txt. This closes the missing explicit 500/501 boundary coverage without modifying frozen files.
- git diff --check: pass.
Read root full-large-scope.tap: 2104 pass, zero fail, one skip. No broad suite or native call repeated by critic.

Acceptance-input concern for continuation: bind a new exact baseline/source manifest to the preserved native-generated candidate and record its patch SHA plus the separate Composer metadata correction. Pin both actual kernel and Composer-relock checks and retain their real output/check proofs before cleanup. The interrupted original trial is failed-before-QA; later continuation must remain a separate, explicitly reused-artifact result. Source approval here neither accepts generated target code nor authorizes altering retained unsafe private DBs.

Status: complete for narrow source review.
Scope expansion: none
