# AUT-01 assignment adapter API

`src/spec-assignment-adapter.js` exports `adaptAssignments({ workspaceRoot,
contextResult, expectedContextSha256, map, analysisResult })`. The workspace
root and accepted digest are trusted caller inputs. Context sources must come
from a successful `loadContext`; the structural result comes from
`analyzeTaskMap`.

The deterministic result contains `ok`, every compiled `proposals` entry with
its contract validation outcomes, map/structural validation status, a per-task
`reviewPlan` with future evidence dependencies, offline `assumptions`,
`implementationAcceptance: "not_evaluated"`, and sorted `findings`. Each
proposal includes an assignment object with no workspace or attempt identity.
The workspace is used only for the internal direct-specialist contract check.

Routine work has engineer then verifier proposals. Gated work also has an
auditor proposal. All share the same review metadata. Verifier scope comes from
selected checks' `verifierWritePaths`; auditor `allowedFiles` is empty and its
check strings state that verifier execution evidence is pending. Risk tags are
the union of linked requirement tags, matching implementation and selected
verifier-scope risk rules, and task `additionalRiskTags`, with the context's
precedence. Oversized or invalid inputs produce blocking findings; fields are
never truncated. Passing validates offline shape only. Live run state remains
required before dispatch.
