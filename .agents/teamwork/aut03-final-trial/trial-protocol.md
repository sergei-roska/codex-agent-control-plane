# AUT-03 paired trial protocol pointer

The first protocol draft was superseded after independent review. The single
source of truth for all cohort conditions, prompts, hashes, scoring, resource
thresholds, setting lifecycle, analyzer/adapter checks, and final reviews is
`docs/evidence/aut-03/paired-trial-declaration.md` plus its exact pins in
`docs/evidence/aut-03/trial-runtime-pins.json` and
`docs/evidence/aut-03/trial-prompts.json`.

`docs/evidence/aut-03/trial-entry.json` must match those artifacts and keep
`baselineCaptureAllowed` false until independent approval and fresh pre-baseline
checks. The first task under the prior protocol was invalidated after forbidden
worker dispatch and shell commands; revised cohort 1 and cohort 2 are excluded.
Cohort 2 stopped when a skill-on task reached the enforced three-turn cap. The
current declaration sets an eight-turn cap, independently approved in
`docs/evidence/aut-03/revised-controls-review-4.md`; cohort 3 still requires
fresh preflight. No other local protocol text may redefine a threshold or
runtime condition.

The first attempt remains invalid after worker dispatch and shell commands.
Revised cohort 1 and cohort 2 are excluded. Cohort 2 stopped when the skill-on
`bounded-dependencies` task attempted a fourth `turn/start`; the helper blocked
it before sending. Independent review approved the revised cap of eight. The
owner's percentage-threshold override and explicit provider-quota stop remain.
Keep the gate false until fresh task preflight is complete.

The previously accepted offline delivery record remains immutable in
`docs/evidence/aut-03/entry.json` and `delivery-decision.json`.
