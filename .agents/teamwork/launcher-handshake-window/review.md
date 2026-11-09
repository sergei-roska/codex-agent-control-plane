# Handshake usage window review

Mode: Review. Verdict: APPROVE. Status: complete. Scope expansion: none.

Evidence (read): The POST route in `src/launcher-app.js:736-793` resolves the clicked system or named profile home, shares one pending turn per account, reads provider limits only after `startAccountUsageWindow()`, and caches the returned values. An older forced GET cannot replace that cache because of the epoch check at lines 662-677. The UI at `launcher-ui/app.js:1533-1576` requires completed-turn and limits-read fields, refreshes the selected card, retains status across render, and labels an absent future primary reset as pending. Request ID and revision checks at lines 1621-1627 prevent older GET responses from replacing handshake data.

Evidence (read): `src/codex-app-server.js:799-824` creates a disposable cwd and calls one ordinary `run()` with a low-effort `gpt-6.1-sol` turn, empty selected skills/MCP tools, strict read-only policy, no network, and an ephemeral thread. The normal run path waits for `turn/completed`, bounds RPC and terminal waits, handles notification-before-response races, and cleans background terminals. The handshake wrapper rejects any status other than completed. The launcher closes the disposable App Server in `finally`. Installed local schema `/tmp/launcher-handshake-schema/codex_app_server_protocol.schemas.json` supports `thread/start.ephemeral` and `readOnly.networkAccess`.

Evidence (ran): `node --test test/launcher-accounts.test.js test/launcher-handshake-ui.test.js` passed 22/22. The focused App Server/account pattern passed 9/9. `git diff --check` passed. A scratch VM probe of the actual `formatResetCountdown`, `limitBlock`, `accountBlock`, and `renderAccounts` functions passed: a future provider reset rendered an immediate `Resets at ... (4h 59m)` countdown and success status. Evidence (lead report): The two full App Server suite failures reproduced against HEAD source and HEAD test via an in-memory preload, so they are baseline failures.

Limit: No live provider model turn or observed real usage-window transition was performed, as required by the brief. Source and fake-process checks qualify the implementation and protocol shape, not the provider's eventual limit-update timing.

Non-blocking: The legacy `handshake.title` still says `Check this account connection` at `launcher-ui/app.js:1522`; the action now starts a model turn. Align its tooltip with the new behavior.
