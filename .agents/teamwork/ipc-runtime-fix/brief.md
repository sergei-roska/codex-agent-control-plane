# Verifier IPC runtime fix

Implement a permanent Harness system policy for repeated verifier IPC EPERM.
Writable verifier turns and standard agent acceptance checks receive sandbox
network access only where safely expressible. Preserve filesystem roots,
candidate binding, script pins, writer admission and review receipts. Do not
bypass modern managed profiles or use full access as a workaround. Document that
Codex exposes general network access, not an IPC-only capability.

Allowed source paths: src/codex-app-server.js, src/acceptance.js,
src/execution-permissions.js, src/verification-preflight.js, focused tests and
relevant docs. No target project edits, service restart, or Git mutation.
