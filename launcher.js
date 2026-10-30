'use strict';

const { readAuthToken } = require('./src/local-auth');
const { createProjectManager } = require('./src/launcher-projects');
const { createLauncherApp } = require('./src/launcher-app');

const PORT = Number(process.env.LAUNCHER_PORT) || 8081;
const HOST = '127.0.0.1';

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

async function main() {
  const projects = createProjectManager(process.env.LAUNCHER_RUNTIME_DIR ? { runtimeDir: process.env.LAUNCHER_RUNTIME_DIR } : {});
  await projects.init();
  const app = createLauncherApp({ projects, readAuthToken });

  try {
    await listen(app, PORT, HOST);
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      throw new Error(`Launcher could not bind to ${HOST}:${PORT}: the port is already in use. Set LAUNCHER_PORT to a free port.`, { cause: error });
    }
    throw error;
  }
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
      await projects.stopAll();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`Launcher listening at: http://${HOST}:${PORT}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
