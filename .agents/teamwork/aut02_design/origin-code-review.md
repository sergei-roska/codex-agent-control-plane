# AUT-02 origin-code classification review

Verdict: REJECT current direct/graph contract at direct service hash `e3ca7ce3a37e43f6950fe47b1915c2a52a2bfe5ea9b8f343b2ebf044160104cf`; this supersedes the narrow direct tuple approval for Q06.

Blocking: `src/a2a-role-service.js:527-556,705-718` [read]: `originatingReviewContinuationMatches` returns false for absent, corrupt, unknown-version, ambiguous, saturated, or unavailable binding evidence and for a valid binding with a wrong tuple digest. Preflight reports `review_origin_stale` for all of them. `src/lead-graph.js:981-997` [read] accepts that exact structured code for deterministic fresh review, so an unavailable or corrupt origin can trigger new review attempts even though the runbook requires Q06 retry only after trustworthy origin state exists (`docs/aut-02-fresh-review-runbook.md:145,189`). Fix: return a three-way result: valid match, valid record with digest mismatch, or unknown/untrustworthy record. Map only mismatch to `review_origin_stale`; map unknown to `review_origin_unknown` or another nonrecoverable code. Preserve all-null fresh fallback after the existing target check. Add a graph-plus-real-service negative probe with deleted/corrupt binding and assert zero automatic fresh review submissions; keep the forged A-thread/B-attempt case as stale.

Status: partial
Scope expansion: none
