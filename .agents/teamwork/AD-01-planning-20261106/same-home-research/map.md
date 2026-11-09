# Same-home auth rotation identity boundary

Evidence is read-only. No provider call or test was run.

## Confirmed code facts

- `src/delivery-provider-identity.js:13-30,32-50` reads current `<codexHome>/auth.json` on each identity lookup, extracts `tokens.account_id`, hashes it, and pairs it with realpath home. It does not identify which credentials a running child loaded.
- `src/app-server-switch.js:32-39` creates one App Server per selected home and caches it. `:42-69` swaps only when active home differs, waiting for in-flight work; auth file changes do not trigger a swap. `:72-119` computes the binding identity after selecting/reserving the target and immediately before invoking its `run`, but identity comes from the current file via `providerIdentityFor(identityHome)` while `target` may be a long-running instance. Thus an auth.json replacement at the same home can durably bind account B while target process still has account A credentials loaded.
- `src/codex-app-server.js:174-200,435-447` stores codexHome in the client and passes it as child `CODEX_HOME` at spawn. A child generation is reused while alive (`:254-258`); this source does not show the CLI's credential reload semantics. Child death causes supervised replacement, but no auth file watcher/fingerprint is present in the client lifecycle.
- `src/codex-app-server.js:604-610` sends `account/read` to that client and returns `account` plus `requiresOpenaiAuth`; `:2110-2116` sanitizes account to `type`, `email`, `planType`, `usesCodexManagedCredentials`. It strips account ID. The API response is process-originated, but code does not prove whether CLI derives it from loaded process state or rereads auth.json; nor is the return shape enough to match the durable hashed `accountId` reliably.
- `src/app-server-switch.js:160-165` passes `getAccount` through to current instance, so this could check the selected process but cannot establish durable account hash with current sanitized shape.

## Inference and answer

Confirmed: call binding currently records the configured auth-file identity at call time, not a verified identity of credentials loaded by the already-running provider process. Auth replacement in the same home does not itself recreate the child. Therefore it can misattribute a call if the CLI retains startup-loaded auth. Whether a given CLI version actually retains it is not established by this repository; that is the unresolved runtime behavior.

`account/read` is authoritative only for the account state reported by the selected child at request time, not demonstrably for a credential snapshot tied to the next turn. Even if it reflects process state, its sanitized response omits account ID, so it cannot currently be compared against the hashed binding identity. Email is optional and is not a robust substitute.

## Existing tests and smallest closure

- `test/delivery-provider-identity.test.js:20-31` confirms file identity changes after auth metadata replacement; it does not test a child process.
- `test/app-server-switch.test.js:161-196,212-237,239-250` verifies hashes and switching across homes, call reservation, and fail-closed missing identity; no same-home auth rewrite test exists.
- `test/codex-app-server.test.js:2917-2939` tests account/read timeout, not credential rotation or returned account identity.

Smallest ownership: change `src/app-server-switch.js` plus `test/app-server-switch.test.js` to detect same-home auth identity change and fence/recreate before binding/dispatch, with no call in flight. Add a narrow `src/codex-app-server.js`/`test/codex-app-server.test.js` change only if account/read must expose a stable provider account identifier; avoid exposing raw tokens. The most reliable local invariant is process-generation fencing on auth fingerprint change, then query identity from the fresh process if protocol exposes a comparable stable ID. Otherwise the lead should state the guarantee as configured-file identity, not provider-loaded identity. A fixture can simulate retained old identity and prove no next dispatch occurs on the stale generation; real CLI credential reload behavior requires provider qualification outside this research scope.
