'use strict';

const { readAuthToken } = require('./src/local-auth');
const { createProjectManager } = require('./src/launcher-projects');
const { createLauncherApp } = require('./src/launcher-app');

const PORT = Number(process.env.LAUNCHER_PORT) || 8080;

async function main() {
  const projects = createProjectManager(process.env.LAUNCHER_RUNTIME_DIR ? { runtimeDir: process.env.LAUNCHER_RUNTIME_DIR } : {});
  await projects.init();
  const app = createLauncherApp({ projects, readAuthToken });

  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Launcher listening at: http://127.0.0.1:${PORT}`);
  });

  setInterval(() => { projects.refresh().catch(() => {}); }, 2000);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await projects.stopAll();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
