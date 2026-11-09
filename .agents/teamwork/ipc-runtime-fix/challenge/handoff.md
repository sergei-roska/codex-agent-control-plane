# IPC boundary challenge

Verdict: HOLDS for the probed strict acceptance boundary. No reviewed source,
existing test, fixture, config, Git state, target project, or service was changed.

Probe: `challenge/boundary-probe.js` uses the real `CodexAppServer` command/exec
path and `runSandboxedCheck` without a model turn. It runs three sequential
checks on one App Server process: strict with empty writable roots, scratch-only
with one writable root, then strict again. Each check attempts writes in the
owned probe workspace, the scratch directory, and a sibling outside directory;
it also binds a loopback socket. Strict attempts all returned EROFS while the
socket bind succeeded. Scratch-only allowed only the scratch write and the
socket bind. The final strict call again denied all three writes. This also
probes per-call policy isolation after the scratch call.

Reproduce from repository root:
`node .agents/teamwork/ipc-runtime-fix/challenge/boundary-probe.js`

Observed command exit 0. Output:
`{"strict":{"workspace":"EROFS","scratch":"EROFS","outside":"EROFS","loopback":"allowed"},"scratchOnly":{"workspace":"EROFS","scratch":"allowed","outside":"EROFS","loopback":"allowed"},"strictAgain":{"workspace":"EROFS","scratch":"EROFS","outside":"EROFS","loopback":"allowed"}}`

Legacy inherited acceptance intentionally preserves native workspace roots as
the brief requires; a writable workspace there is not an adversarial finding.
The role policy composition and preflight distinctions were inspected in the
diff and focused existing tests, but no paid model turn was run. The runtime
probe qualifies only acceptance command/exec filesystem and loopback behavior.
