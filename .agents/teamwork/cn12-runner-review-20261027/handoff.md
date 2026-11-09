# CN12 scoped runner review

Verdict: REJECT for scoped preparation as currently implemented.

Evidence (ran): `env -u NODE_TEST_CONTEXT node --test test/delivery-acceptance.test.js test/candidate-review.test.js` passed 20/20.

Blocking (ran): `src/delivery-acceptance.js:33,209` uses the materialized candidate path `.codex-acceptance-gitconfig` as `GIT_CONFIG_GLOBAL`, then runs `git add -f --all`. A real disposable CandidateStore/runFrozenCandidateChecks probe with candidate `.gitattributes`, `.codex-acceptance-gitconfig`, and a clean filter wrote a marker outside the candidate workspace on the host before the owner check. The check result was still `accepted`. Probe: `.agents/teamwork/cn12-runner-review-20261027/git-filter-probe.js`; command: `node .agents/teamwork/cn12-runner-review-20261027/git-filter-probe.js`; output: `marker:true, disposition:accepted`. This is candidate-controlled host execution outside the intended acceptance sandbox. Fix: keep all Git config outside candidate-controlled paths, sanitize inherited Git environment, and disable candidate-defined filters when staging the mirror.

Additional read finding: `src/delivery-acceptance.js:129-135,231-245` accepts a missing/undefined admission release result and treats a rejected release promise as an ordinary error, cleaning the mirror despite unproven release. Require explicit terminal release evidence; retain reconciliation context on unknown release.

Read: The projection validates direct/promoted receipt context and current checkpoint pins and blocks unsettled review tasks. No blocking projection defect established. This review does not qualify unfinished CN12 finalization.
