# Completed: default-profile lead startup identity fix

Root cause: switching wrapper stored null for the default profile while concurrent provider identity pinned its concrete canonical home; first lead turn failed provider_home_changed before model execution. Fixed by separating profile selection from a canonical effective home snapshot per App Server instance. Actual profile/account change guards remain intact.

Scoped delta: src/app-server-switch.js and test/concurrent-delivery-engine.test.js only versus saved dirty baseline. Preserve all inherited uncommitted work. No commits/pushes/live task probes/database edits.

Acceptance: independent APPROVE; 8 wrapper, 6 focused engine, 70 server/provider tests passed; default/env/base/selected/symlink probes passed. Full repository suite not run. See lead-start-20261029/handoff.md, review.md, evidence/regression-proof.json and evidence/runtime-proof.json.

Original project 3d9c2e759c stopped at explicit owner request; launcher confirms pid null and status stopped. Reviewed source hash was verified before stop. Old owner-canceled task unchanged; no new planner turns. Owner should launch a new task to continue work. Recovery project3003 remains stopped. No root workers or acceptance tasks remain active.

Prior terminal-engine-fence and e4c3c recovery evidence remains intact; prior PROJECT saved in lead-start-20261029/previous-PROJECT.md.
