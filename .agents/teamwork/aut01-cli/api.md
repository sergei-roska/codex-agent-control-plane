# AUT-01 analysis and CLI API

`src/spec-analyzer.js` keeps the P1.2 `analyzeTaskMap` API and adds
`analyzeWorkspace({ workspaceRoot, contextPath, contextSha256, mapPath,
profilesDir })`. The wrapper reads bounded immutable input buffers, validates
context/map/source/artifact references, computes graph and task projection
results, compiles all assignment proposals, verifies code/profile hashes, and
rechecks observed inputs before returning.

The workspace and profile roots are absolute caller-trusted paths. Context and
map paths are safe workspace-relative paths. The accepted context digest comes
from the caller; the map cannot supply it as authority. The returned
`spec-analysis/v1` report includes `analysisFingerprint`, byte/version manifest,
offline assumptions, structured findings, full requirement/criterion coverage,
dependency order, every assignment plus both contract outcomes, review plan,
pass status for each phase, and `implementationAcceptance: "not_evaluated"`.
No absolute workspace/profile path, clock, random value, or live attempt ID is
included in the deterministic result.

`tools/spec-kit/analyze.js` accepts only `--workspace`, `--context`,
`--context-sha256`, `--map`, `--profiles`, and `--json`. It prints one JSON
report to stdout; exit codes are 0 pass, 1 blocked, 2 review, and 3 internal
failure. It does not write files, execute planned checks, or call services.

Snapshot file limits are 1 MiB each for context/map and 4 MiB for each source,
artifact, checker, contract, and profile file; all captured inputs share a
32 MiB budget. Counts are checked before analysis. Captured bytes are hashed
and parsed; source and task text extraction uses those captured buffers. This
detects observed drift, but is not an atomic filesystem snapshot under
concurrent writers.
