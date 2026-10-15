'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

function loadRuntimeIdentity({ root = __dirname, loadIdentity = () => require('./src/runtime-identity') } = {}) {
  const identityPath = path.join(root, 'src/runtime-identity.js');
  const originalLoader = Module._extensions['.js'];
  let identitySourceHash = null;
  const captureIdentity = (module, filename) => {
    if (path.resolve(filename) !== identityPath) return originalLoader(module, filename);
    const source = fs.readFileSync(filename);
    identitySourceHash = crypto.createHash('sha256').update(source).digest('hex');
    Module._extensions['.js'] = originalLoader;
    module._compile(source.toString('utf8'), filename);
  };
  Module._extensions['.js'] = captureIdentity;
  let identityModule;
  try {
    identityModule = loadIdentity();
  } finally {
    if (Module._extensions['.js'] === captureIdentity) Module._extensions['.js'] = originalLoader;
  }
  if (!identitySourceHash) throw new Error('The runtime identity module was not captured during bootstrap');
  return { identityModule, identitySourceHash };
}

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
