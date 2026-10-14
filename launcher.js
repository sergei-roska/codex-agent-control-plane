'use strict';

const { createRuntimeIdentity, DEFAULT_SOURCE_FILES } = require('./src/runtime-identity');
const runtimeIdentity = globalThis[Symbol.for('codex.launcher.runtimeIdentity')]
  || createRuntimeIdentity({ sourceFiles: [...DEFAULT_SOURCE_FILES, 'launcher.js'] });
const path = require('node:path');
const { loadOrCreateAuthToken, readAuthToken } = require('./src/local-auth');
const { createProjectManager } = require('./src/launcher-projects');
const { createLauncherApp } = require('./src/launcher-app');
const { createSystemAgentService } = require('./src/system-agent-service');

const PORT = Number(process.env.LAUNCHER_PORT) || 8080;

async function main({ runtimeIdentity: identity = runtimeIdentity } = {}) {
  identity.seal();
  const repoDir = path.resolve(__dirname);
  const runtimeDir = process.env.LAUNCHER_RUNTIME_DIR
    ? path.resolve(process.env.LAUNCHER_RUNTIME_DIR)
    : path.join(repoDir, '.runtime');
  const systemAgentUrl = 'http://127.0.0.1:' + PORT + '/agents/chuck-norris';
  const systemAgentTokenFile = path.join(runtimeDir, 'system', 'chuck-norris', 'a2a-token');
  const systemAgentToken = loadOrCreateAuthToken({ filePath: systemAgentTokenFile });
  const systemAgent = createSystemAgentService({
    repoDir,
    runtimeDir,
    endpoint: systemAgentUrl,
    token: systemAgentToken,
    runtimeIdentity: identity,
  });
  const projects = createProjectManager({
    repoDir,
    runtimeDir,
    systemAgentUrl,
    systemAgentTokenFile,
  });
  await projects.init();
  const app = createLauncherApp({ projects, readAuthToken, systemAgent });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Launcher listening at: http://127.0.0.1:${PORT}`);
  });

  setInterval(() => { projects.refresh().catch(() => {}); }, 2000);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      try {
        await app.closeAccountLogins?.();
      } catch (err) {
        console.error('closeAccountLogins failed:', err);
      }
      try {
        await app.closeSystemAgent?.();
      } catch (err) {
        console.error('closeSystemAgent failed:', err);
      }
      await projects.stopAll();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
