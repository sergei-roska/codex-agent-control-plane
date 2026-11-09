# V42 and V16 challenge

Verdict: BROKEN
Status: partial

Two V42 visibility assertions fail in the owned probe:
- Two candidate intents exist for one attempt, but only one timing insert succeeded. The projection returns 1000 ms rather than null because its inner join ignores the untimed intent. Best-effort writes can omit that timing row. Count all intents before selecting an unambiguous timing.
- Creation timestamp -1000 and claim timestamp 1000 produce backlogMs 2000 rather than null. elapsed accepts negative numeric timestamps. The probe sets stored evidence directly; this establishes projection behavior, not an external attack path.

Reproduce: node --test .agents/teamwork/wait-attribution-20261028/challenge/probe.cjs
Result: 1 pass, 2 fails. Probe uses in-memory disposable data. The first passing case tests multiple timed intents and revised tasks.

V16 bounded existing retry and stale-owner/check tests: node --test --test-reporter=tap --test-name-pattern='failed scoped reviewer retry preserves a qualified sibling and cannot qualify a newer candidate|settlement rejects stale owner/check identity' --test-skip-pattern='candidate attributes and inherited Git configuration cannot execute filters while mirroring' test/candidate-review.test.js
Result: 2 pass. This does not test a process crash or live provider. No standalone telemetry-write failure injection was run; the two observed failures are projection probes.

Inputs hashed after probes: candidate-store ebc9b0704624665f8fba636b968019cd945a3638058115c6706dacd43b41fcd6; delivery-role-service 1c39360f79a212453bdbab4a805b4957f684c360a36089a52cc8a2600ccdca1b; delivery-visibility e4de17fa1be7a988902dbba26f4fe53e980b3c4397260ccca85bdb5e32c93d8e; backlog UI 1f241b4a502c5d111d9bea6027875955fc094c333a9587f736f21de5aa9dae7d; candidate-review test 001c2f11a1c4be35f655d1d6b041cfdb48c7b92f81a5d13f809d3483fa3d80b6; candidate-review source d849d11112be7188380316d316b4e92a84804a279e8798173d0777b6bfd4d615; backlog-store ca648b7c0e1151c4430a4aa73a5f55e660a5ed092e4bc8b4ef9a25779659c18f. These match independent review snapshots. Other files were not frozen.

Next: repair projection and rerun the owned probe, then re-review affected frozen inputs. No source or Git mutation performed.
