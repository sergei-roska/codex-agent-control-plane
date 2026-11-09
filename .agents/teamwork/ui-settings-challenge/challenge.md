# Verdict: BROKEN

## Failure: manual forced account refresh does not update cache after an older read completes first

Probe: `.agents/teamwork/ui-settings-challenge/probe-force-cache-race.js`.

Input: A disposable Express launcher app with one fake system account. A background `/api/accounts` read starts and captures usage 10, then manual `/api/accounts?force=1` starts and captures usage 20. The background read completes first, followed by the force read. A subsequent ordinary GET reads the cache.

Expected: The force response and the subsequent cached GET both show usage 20, since the later manual force request is authoritative for the account cache.

Actual: The force response shows 20, but the subsequent cached GET shows 10. The probe prints `{"forced":20,"cached":10,"reads":2}` and fails its assertion.

Reproduce: `node .agents/teamwork/ui-settings-challenge/probe-force-cache-race.js`.

Cause: `src/launcher-app.js:679-685` snapshots `limitsCacheEpochs` before each read. Whichever read completes first advances the epoch. The later force read sees a changed epoch and returns its new value to the requester without updating the cache. This behavior comes from the changed code. The previous implementation wrote each successful completion to the cache, so this completion order would leave usage 20 cached. A handshake update needs a stronger guard, but ordinary background reads should not outrank a later force request.

## Other checks

Read the reviewed role UI and API, including Save/Reset binding, selection revision, inherited effort serialization, Fast tier matching, and account UI request generation. Existing tests exercise these cases; no additional independent failure was established for them. The probe uses only a disposable local server and fake App Server, with no real profile, provider, model call, or service lifecycle action.

## Status

Complete for the focused challenge. Product files unchanged. The scratch probe and this report should be preserved until root triages the finding.
