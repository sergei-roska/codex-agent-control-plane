# AD-02 authentication research brief

Purpose: hand off evidence for owner re-login after all configured profiles require authentication.

Constraints:
- Research only; no code or test edits, live credentials, real providers, staging, or commits.
- `src/lead-graph.js` is currently owned by AD-04; wait for its release before implementation.
- Keep task output free of credentials and profile-home paths. Never request credentials in chat.

Key evidence:
- `getAccount().requiresOpenaiAuth` is explicit; rate-limit read null is ambiguous.
- Legacy graph currently handles quota as a wait but throws auth failures.
- The budget watcher currently discovers profile-file changes and polls; it does not observe re-authentication of an existing profile.
- Accounts UI can add a new authenticated profile, but cannot re-authenticate an existing one. Existing design doc marks token-expiry re-login UX open.

See `handoff.md` for source paths, call-chain facts, and proposed deterministic tests.
