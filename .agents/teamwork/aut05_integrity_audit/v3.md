# AUT-05 v3 final evidence audit

Verdict: APPROVE
Status: complete
Scope expansion: none

This approval covers the frozen offline evidence candidate and its bounded
interpretation. The lead's separate `baseline_ready` decision and durable
AUT-01 handoff remain pending. It does not reverse the v2 rejection; v3 is a
new revision with a concrete source join.

## Exact reviewed target

- Baseline `4fe46b3cc7d7a67e5bc1df2c5347f5bcd007fccb808a8294671d0a0ee0183786`.
- Corpus `bf180584c4ee3620b2c676f42e0c09be8d977dec2d82cbd39e3fd90cf60485fc`.
- Observations `99b50d7b5c2983ca3d380507120d08ac3caf4965ab3daede3832d263fe24defa`.
- Failed usage export `24a1f47bc94051775ebb988a3d56a56581c8de56a176348f818a084f1d834c88`.
- Evaluator `829ad5dc365404712a9382964ffd5dc91387a1eb2d1d35785919c62438982f25`.
- CLI `ea73d34140f9932ebef0cf692c53efa7e3ee8d69caf02916c23d4d49bcb7e05e`.
- Metric definitions `55ab34120292726741263bfba9e8498f8db09304a5510caec446d0311ef4c8ed`.

## Criteria, runbook section 10

1. PASS [read]: Seven cases cover four named incident families, an ordinary
   control, a failed/incomplete usage control, and the frozen manual AUT-01
   planning artifact. Its independent 5/5 score is semantic only; structural
   traceability is absent.
2. PASS [read]: The former provenance gap is resolved. The v3 export identifies
   one failed auditor task, its dispatch attempt, usage row, and performance
   projection. I independently queried the selected source rows read-only and
   confirmed the task/assignment/attempt join; the usage row is failed with
   `token_source=unavailable`, `tokens_json=NULL`, and 5573 ms for one attempt.
   The other five historical cases remain bounded handoff summaries with
   unknown pre-repair revisions and runtime effects.
3. PASS [read/ran]: The final baseline pins current corpus, observations,
   export, historical notes, source checker, CLI, schemas, metric definitions,
   manual planning artifact, assessment, and canonical planning inputs. Source
   SQLite and performance raw hashes and the launcher snapshot hash match the
   export claims. Current CLI replay validates the pinned local artifacts.
4. PASS for declared offline scope [read/ran]: Current CLI exits 0 with
   `valid=true`, `assessed=true`, `ready=false`, seven cases/observations,
   4 pass, 2 fail, 1 inconclusive, planning semantic preservation 5/5, and
   accepted results null. The six restored manifest limitations retain no-live,
   no-measured-spend, manual-artifact, semantic-only, and single-attempt bounds.
   No live behavior, workflow/model improvement, accepted implementation
   count, measured cost, first-pass ratio, or complete elapsed time is claimed.
5. PASS [read]: Independent technical verifier approved exact final v3 bytes in
   `.agents/teamwork/aut05_final_review/v3-final.md`. This audit independently
   checked provenance and interpretation. Existing focused run was 49/49;
   lead reported full v3 integration run of 1144 pass, 0 fail, 1 skip.
6. UNVERIFIED as a lead-owned next step [read]: Final durable `baseline_ready`
   decision and AUT-01 handoff have not been recorded. Empty manifest review
   references and `eligibility.ready=false` are correct for a captured artifact;
   the lead can reference this audit and verifier without rewriting the manifest.

The v3 fixture delta changes the failed/incomplete usage case and observation,
retains the manual planning capture, and leaves evaluator, CLI, schemas, and
metric definitions unchanged. No assertion was weakened or source outcome
hardcoded in this delta. The previously rejected b986 baseline omitted key
limitations; the final 4fe baseline restores them. No reviewed source, test,
fixture, or config was edited by this audit.
