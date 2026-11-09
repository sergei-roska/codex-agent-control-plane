'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const filename = path.resolve('test/server-delivery-engine.test.js');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
const source = fs.readFileSync(filename, 'utf8').replace(
  "assert.equal(closeCalls, 0, 'provider close must wait for held invocation');",
  "assert.equal(closeCalls, 99, 'injected failure to verify disposable fixture cleanup');");
loaded._compile(source, filename);
