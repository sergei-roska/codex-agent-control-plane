'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function sourceFilesUnder(root, relativeDir) {
  const directory = path.join(root, relativeDir);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) files.push(...sourceFilesUnder(root, relative));
    else if (entry.isFile() && /\.(?:js|cjs|mjs)$/i.test(entry.name)) files.push(relative);
  }
  return files.sort();
}

const DEFAULT_SOURCE_FILES = Object.freeze(sourceFilesUnder(path.resolve(__dirname, '..'), 'src'));

function sha256(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function createRuntimeIdentity({ root = path.resolve(__dirname, '..'), sourceFiles = DEFAULT_SOURCE_FILES, initialSourceHashes = {} } = {}) {
  const projectRoot = path.resolve(root);
  const loadedAt = new Date().toISOString();
  let startupGitRevision = null;
  try {
    startupGitRevision = execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch (_) { /* The source directory may not be a Git checkout. */ }

  const files = new Map(sourceFiles.map((file) => [path.resolve(projectRoot, file), file.split(path.sep).join('/')]));
  const digests = Object.create(null);
  for (const [file, digest] of Object.entries(initialSourceHashes)) {
    if (!files.has(path.resolve(projectRoot, file)) || !/^[a-f0-9]{64}$/i.test(digest)) continue;
    digests[files.get(path.resolve(projectRoot, file))] = digest;
  }

  const originalLoader = Module._extensions['.js'];
  let sealed = false;
  let snapshot = null;
  let profileHashes = Object.create(null);
  const captureLoader = function captureLoadedSource(module, filename) {
    const resolvedPath = path.resolve(filename);
    const relativePath = files.get(resolvedPath);
    if (!relativePath) return originalLoader(module, filename);
    const source = fs.readFileSync(filename);
    digests[relativePath] = sha256(source);
    try {
      module._compile(source.toString('utf8'), filename);
    } catch (error) {
      delete digests[relativePath];
      restoreLoader();
      throw error;
    }
  };
  function restoreLoader() {
    if (Module._extensions['.js'] === captureLoader) Module._extensions['.js'] = originalLoader;
  }
  Module._extensions['.js'] = captureLoader;

  return {
    seal() {
      if (sealed) return snapshot;
      try {
        const uncapturedSourceFiles = [...files.values()].filter((file) => !Object.hasOwn(digests, file));
        const loadedUncapturedSourceFiles = [...files.entries()]
          .filter(([absolute, file]) => require.cache[absolute] && !Object.hasOwn(digests, file))
          .map(([, file]) => file);
        snapshot = Object.freeze({
          schemaVersion: 1,
          pid: process.pid,
          moduleLoadedAt: loadedAt,
          startupGitRevision,
          sourceHashes: Object.freeze({ ...digests }),
          profileHashes: Object.freeze({ ...profileHashes }),
          uncapturedSourceFiles: Object.freeze(uncapturedSourceFiles),
          loadedUncapturedSourceFiles: Object.freeze(loadedUncapturedSourceFiles),
        });
        sealed = true;
        return snapshot;
      } finally {
        restoreLoader();
      }
    },
    captureProfileSource(file, source) {
      if (typeof file !== 'string' || typeof source !== 'string') throw new TypeError('file and source must be strings');
      const absolute = path.resolve(projectRoot, file);
      const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return sealed ? snapshot : null;
      profileHashes[relative] = sha256(source);
      if (sealed) snapshot = Object.freeze({ ...snapshot, profileHashes: Object.freeze({ ...profileHashes }) });
      return sealed ? snapshot : null;
    },
    get snapshot() {
      if (!sealed) throw new Error('Runtime identity has not been sealed');
      return snapshot;
    },
  };
}

module.exports = { DEFAULT_SOURCE_FILES, createRuntimeIdentity };
