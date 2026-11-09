# CN14 core engine resume

Owner: core resume worker. Root owns Git/docs/startup. Router owns router source
and tests. This worker owns the new concurrent engine and tests, plus the two
narrow dependency scopes explicitly granted by root: planning admission in
delivery-role-capabilities and task contract/lookahead plus digest pin fixes in
delivery-output-artifacts. No other accepted dependency or startup edits.

Initial goal: reproduce the exact 8-second unknown lead-turn failure, prove its
cause, then qualify actual lead -> configured authenticated private role ->
candidate receipt -> frozen acceptance with fake AppServer and disposable
Git/SQLite. Further core qualification covers concurrent engineering and the
stable run/resume/control/correction/shutdown/reopen facade.

Constraints: preserve inherited dirty paths; no live models/providers/accounts,
shared services, targets, dependencies, or Git writes. Disposable fixture Git
commits are allowed. Do not rerun the blocked hostile Git probe/regression.
Keep all authored files English/ASCII. The root cutoff pauses new recovery work;
finish only the combined owned suite and this handoff.

Known full-core gaps to preserve explicitly: invalid planner output must only be
recovered through persisted actual host thread/process/turn facts and accepted
lifecycle proof APIs; controls/reopen/shutdown and uncertain effects need more
qualification; the host default empty-owner-checks path currently reports
delivery_role_check_evidence_invalid and must not be bypassed. CN14 is not
accepted until these and independent review are complete.
