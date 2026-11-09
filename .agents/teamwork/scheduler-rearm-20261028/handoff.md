# Scheduler repair accepted

Read brief.md, worker-handoff.md, review-final.md and challenge/handoff.md.
Early callback rearming is repaired; native-Promise completion interleaving is
covered by a retained regression. Initial independent REJECT is preserved in
review.md with repro and rejected candidate copies; final review APPROVE and
challenge HOLDS. Worker and independent scheduler/executor tests44/44.

Frozen verification (exact commands):
python3 .agents/teamwork/scheduler-rearm-20261028/verify-frozen.py affected
python3 .agents/teamwork/scheduler-rearm-20261028/verify-frozen.py full
Affected752/749pass/3fail/0skip: two predecessor affected failures plus known
launcher signal-exit failure, already present predecessor full. Full1910/1898pass/
11fail/1skip: no new failure names; earlier direct-resume correction timeout not
observed. Both no timeout/inputDrift/cancellations. baseline-comparison.json and
verification-{affected,full}.{json,tap}. Suite is not green. Do not infer historical
causality or claim launcher fixed. Original early callback regression fails old
source; Promise race regression fails rejected candidate. No raised timeouts.

Root updated durable implementation-status.md and foundation-api.md after test
freeze; reviewed product/test hashes unchanged. preservation-final.json proves
122/122 inherited files retained, only expected scheduler/test and two docs
changed; no source drift, unexpected files or ASCII violations. git diff --check
and node --check for scheduler source/tests passed. source-final.json records
final hashes. Ignored evidence may disappear; retained tests remain in test/.

No staging/commit/push/restart/deploy/live provider trial, account/settings/model
changes, dependency installs or real target mutation. Root owns Git/docs.
Final critic milestone APPROVE: acceptance.md, all bounded criteria PASS.
Critic independently verified frozen evidence, reviewed hashes, preservation and
documentation, and reran the targeted challenger probe successfully.
Next: broader unsafe-shutdown terminal reconciliation, ordinary cooperative
retry-close and integrated CN14/CN15. Read predecessor handoff pending sections
and its correction/shutdown-worker-case.cjs/repro log. Cleanup receipt only covers
provider-managed terminals, not arbitrary escaped processes or noEffect. Do not
relax normal terminal adapter, effect/publication fences, or requeue old goals.
Do not repeat architecture research. No new production correction control route.

All delivery-acceptance/full commands MUST retain exact exclusion:
--test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring'
Never run the prohibited named test. Do not record quota in handoffs.
