# Historical handoff source notes

These notes preserve bounded findings summarized in reviewed handoffs. They are historical summaries, not runtime receipts or proof of authorization, write, or accepted task outcomes. The target repository is separate from this harness and was at HEAD `49d390c9b2b31077a18cecaf228c18604c3a8341` when inspected. The incident pre-repair source revisions are not established. All stated target commits were verified with read-only `git cat-file -e` in that checkout.

## Source file digests at capture

- `.agents/teamwork/PROJECT.md`: `78093af55b539e9ed70eb08f4e5d4e2638103ecdd7fc8137c888dc5e68095317`
- `.agents/teamwork/root/handoff.md`: `312f3154525099d56440b43315b3592d0e67471954b66e45c22022531160f31a`
- `.agents/teamwork/monitor-owner/handoff.md`: `e00b259534dc8a2c8093cee6e974453d747dcbda4f2772aef1a2df255515ff1c`

## Bounded historical findings and pinned repair reviews

- `canonical-identity-contradiction`: monitor-owner/handoff.md lines 129-159 records the r209 finding, r210 repair, and r211 verifier pass at target commit `be71a620c153d6c46e0696a8e53d2fdc56ea4af5`. The pre-repair source revision is unknown. The derivation was read-only and nonauthorizing; no authorization effect is established.
- `nested-manifest-contradiction`: monitor-owner/handoff.md lines 267-288 and root/handoff.md lines 41-49 record auditor r227 finding QA-227-1, repair r228, and verifier r229 pass at `4ecb726155784d99ab17f2d222fc58a96d14e2c8`. The pre-repair source revision is unknown; valid admission remained observation-only.
- `producer-mismatch`: monitor-owner/handoff.md lines 161-184 records QP-212-01, r213 repair, and verifier r214 candidate `c3c1399b314d823e3d4b2ea85191120f3a268b5c` against diff basis `ab952a82e85fa0a701fee62974863f33973a6dfa`; fresh verifier/auditor r216/r217 passed at `bc8e1301cf6d5e76e8c8a4605631d70f22101a06`. The pre-repair source revision is unknown. Evidence does not establish a write or authorization.
- `stale-review-continuation`: root/handoff.md lines 17-22 and monitor-owner/handoff.md lines 185-201 record r215 preflight rejection `request_invalid / review_origin_stale` before model execution; fresh verifier/auditor r216/r217 later passed at `bc8e1301cf6d5e76e8c8a4605631d70f22101a06`. The request was rejected, not an auditor verdict.
- `valid-ordinary-result-control`: monitor-owner/handoff.md lines 192-205 records verifier r216 and auditor r217 passing a bounded checkpoint at `bc8e1301cf6d5e76e8c8a4605631d70f22101a06`; outputs were detached and nonauthorizing. Overall M4 and task acceptance remained null.
- `failed-incomplete-usage`: sanitized evidence `failed-incomplete-usage-evidence.json` joins task `e88656f4-3880-43ce-aa6a-c39b88fa7eeb` to run `a125b4c6-f640-45ae-a106-22f97837f8e9`, assignment `...:r33:a0`, and dispatch attempt `...:r33:a0:t1`. The task failed with `serverOverloaded` / `audit_execution_failed`; its usage row records `tokenSource=unavailable`, null token values, one turn, and 5573 ms. No review verdict, complete workflow interval, measured spend, or target source revision is established.

No historical target run, model identity, complete usage, or runtime effect is inferred from these summaries.
