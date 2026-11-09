const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = '/home/sr/Projects/Workspace/codex-agent-control-plane';
const targets = new Set(['src/codex-app-server.js', 'test/codex-app-server.test.js']);
const original = Module._extensions['.js'];
Module._extensions['.js'] = function (module, filename) {
  const relative = path.relative(root, filename);
  if (targets.has(relative)) {
    const source = execFileSync('git', ['show', 'HEAD:' + relative], { cwd: root, encoding: 'utf8' });
    return module._compile(source, filename);
  }
  return original(module, filename);
};
