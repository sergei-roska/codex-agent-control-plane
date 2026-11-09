# Role settings review handoff

Status: APPROVE after final re-review. All historical blockers are resolved. Source and tests unchanged by critic.
Account cache race follow-up APPROVE: challenge probe forced20/cached20/reads2; account/UI/role/launcher 85/85 pass; handshake invalidation retained.
Focused role/UI/launcher tests 63/63 pass; App Server selected cases 4/4 pass; syntax and `git diff --check` pass.
Exact local probes: `resolveServiceTierForTurn('on', {serviceTiers:[{id:'standard',name:'Standard',description:'Fast tier is unavailable on this plan'}]})` returned `standard`; executing the installed Escape handler with absent `#roleModal` threw a null `classList` TypeError.
The new test invokes actual rendered-card Save/Reset events, checks null effort PUT plus DELETE, and proves a later profile effort update propagates. No live service/model call or Git state change.
