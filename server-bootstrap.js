'use strict';

const { loadRuntimeIdentity } = require('./launcher-bootstrap');

async function bootstrap({ loadServer = () => require('./src/server'), start = (server, runtimeIdentity) => server.startServer({ runtimeIdentity }) } = {}) {
  const { identityModule, identitySourceHash } = loadRuntimeIdentity({ root: __dirname });
  const runtimeIdentity = identityModule.createRuntimeIdentity({
    root: __dirname,
    sourceFiles: identityModule.DEFAULT_SOURCE_FILES,
    initialSourceHashes: { 'src/runtime-identity.js': identitySourceHash },
  });
  const key = Symbol.for('codex.server.runtimeIdentity');
  globalThis[key] = runtimeIdentity;
  try {
    const server = loadServer();
    runtimeIdentity.seal();
    return await start(server, runtimeIdentity);
  } finally {
    delete globalThis[key];
  }
}

if (require.main === module) {
  bootstrap({
    async start(server) {
      const instance = await server.startServer();
      process.stdout.write(`Codex Universal A2A listening at http://${instance.host}:${instance.port}\n`);
      const shutdown = () => instance.close().finally(() => process.exit(0));
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      return instance;
    },
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { bootstrap };
