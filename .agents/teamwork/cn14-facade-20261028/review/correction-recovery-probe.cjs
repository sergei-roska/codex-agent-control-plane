'use strict';
// Uses the repository's disposable fake HTTP/Git/SQLite harness without executing its tests.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '../../../..');
const filename = path.join(root, 'test/concurrent-delivery-engine.test.js');
const source = fs.readFileSync(filename, 'utf8');
const prefix = source.split("test('cooperative writer mode")[0];
const facade = source.slice(source.indexOf('function facadeIntake('), source.indexOf('for (const reopen of [false, true])'));
const correction = source.slice(source.indexOf('function ownerCorrectionMessage('), source.indexOf('async function reopenCorrectionHarness'));
const helper = new Module(filename, module);
helper.filename = filename;
helper.paths = Module._nodeModulePaths(path.dirname(filename));
helper._compile([prefix, facade, correction,
  fs.readFileSync(path.join(__dirname, 'correction-recovery-case.cjs'), 'utf8')].join('\n'), filename);
