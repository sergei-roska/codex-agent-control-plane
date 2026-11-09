# Context transfer trace

Updated: 2026-10-14. Read-only source trace; no tests/runtime actions run.

## Findings

- **Confirmed structured omission in lead prompt.** `src/lead-graph.js:1564-1581` serializes each review obligation with checkpointId, kind, reason, paths and receipt status, but omits `evidenceIds` and `prerequisiteFor`. The stored `obligation.review` retains those fields and dispatch validation expects their exact values (`src/contracts.js:313-352, 572-576, 705-708`). The full prompt says verifier/auditor must repeat both (`src/lead-graph.js:1656`), leaving the model to reconstruct values it was not given. This is a direct contract-to-prompt transfer defect. Minimal fix is to include both stored fields in each obligation projection, preserving arrays as-is. Existing test coverage: `test/lead-graph.test.js` tests linked prerequisite dispatch around 1685-1710 and multi-checkpoint obligations around 1743 onward, but does not assert the prompt's obligation JSON includes either field.

- **Assignment result report is intentionally strict, not lossy in the normal path.** `assignmentResult` takes up to 20 artifacts, caps each display text at 100,000 chars and retains metadata (`src/lead-graph.js:157-224`). For oversized artifact text it sends the uncut text to the oversize hook; `outcomeSummary` parses the first artifact's text (`src/lead-graph.js:1246-1263`). Worker reports have a closed schema with required summary/files/checks/risks/scopeExpansion/decisionRequest (`src/contracts.js:81-138, 414-503`); extra fields are rejected. Existing 300 KB tests show valid full report parsing and evidence storage, and invalid-text projection (`test/lead-graph.test.js:2907-2958`). No confirmed report-parser defect found in these paths.

- **Bounded history is a deliberate context loss point.** `boundedOutcomes` keeps newest outcomes whole where possible, then emits digests, then elisions (`src/lead-graph.js:476-528`); digest preserves identity/status/summary/diagnostic codes and evidence IDs but drops report details such as checks/files/risk items. At the tightest bound, elision keeps only identity/status/violation codes. Tests explicitly assert this behavior (`test/lead-graph.test.js:2986-3055`). Evidence IDs in digests are references; this lead prompt path does not itself expose a read-evidence operation. This is a boundedness tradeoff, not an accidental parser loss. Root's reported r155 retrieval failure is runtime evidence and not established as a code defect by this trace.

- **A2A is transport/task persistence, not automatic cross-role context transfer.** Lead dispatch sends a JSON message containing the assignment fields (including inputs, evidence and review), assignmentId, workspace, report contract and optional continuation (`src/lead-graph.js:2138-2164`). Role service recognizes/validates that structured request (`src/a2a-role-service.js:89-96`, `src/contracts.js:640-724`). `continueFrom` is same-role only and builds continuation from prior outcome metadata (`src/contracts.js:507-516`, `src/lead-graph.js:2225+`); role service resumes that thread when thread ID, lane and Codex home remain usable, otherwise starts a fresh turn with the new request text (`src/a2a-role-service.js:879-906`). No code path automatically transfers a verifier's conversation to an auditor. A2A gives the lead task IDs/context IDs and retrieval semantics; correctness still depends on the lead assembling bounded inputs/evidence for every new role request.

## Smallest durable improvement

1. Add `evidenceIds` and `prerequisiteFor` to `reviewObligationsSection` projection; this repairs an exact known loss using the already stored contract object.
2. For broader historical transfer, prefer a bounded structured evidence manifest with stable assignment/attempt IDs and evidence refs, retaining enough identity when outcomes digest/elide. Avoid copying full transcripts/reports into every A2A request; report text is already stored separately for oversized outputs. The current lead has no evidence-fetch tool evidenced in this call path, so a pointer alone does not make omitted report detail recoverable to the model.

## Useful tests

- `test/lead-graph.test.js`: review prerequisite tests ~1685-1710 and ~1743+, report projection/evidence tests ~2907-2958, bounded outcomes ~2986-3055, continuation ~3831-3854.
- `test/contracts.test.js`: review context and prerequisite validation ~313-365 and direct specialist request checks ~640-724 in source.
- No tests were run for this trace.
