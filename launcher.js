'use strict';

const { startLauncher } = require('./src/launcher-server');

const launcher = startLauncher();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { await launcher.close(); process.exitCode = 0; }
  catch (error) {
    process.stderr.write(`Launcher shutdown failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
launcher.httpServer.once('error', (error) => {
  const port = Number(process.env.LAUNCHER_PORT || 3100);
  const message = error.code === 'EADDRINUSE'
    ? `Launcher port ${port} is already in use. Stop its owner or set LAUNCHER_PORT to another port.`
    : `Could not start launcher: ${error.message}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
