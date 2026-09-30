'use strict';

// Prints a fresh dashboard pairing URL. Authenticates to the running server with the local A2A bearer token.
// Env: PORT (default 3000), CODEX_A2A_TOKEN_FILE (token path override).

const { readAuthToken } = require('./local-auth');

async function main(env = process.env, { fetchImpl = fetch } = {}) {
  const port = Number(env.PORT || 3000);
  try {
    const token = readAuthToken(env.CODEX_A2A_TOKEN_FILE ? { filePath: env.CODEX_A2A_TOKEN_FILE } : undefined);
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/dashboard/v1/pairing-codes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Pairing request failed with HTTP ${response.status}.`);
    const body = await response.json();
    if (typeof body?.url !== 'string') throw new Error('Pairing response did not include a URL.');
    process.stdout.write(`Dashboard pairing URL: ${body.url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; });
}

module.exports = { main };
