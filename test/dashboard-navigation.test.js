'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../web/dashboard/js/layout/header.js'), 'utf8');

function navigationContext() {
  const values = new Map();
  const context = {
    sessionStorage: {
      getItem(key) { return values.get(key) || null; },
      setItem(key, value) { values.set(key, value); }
    }
  };
  vm.runInNewContext(source, context, { filename: 'header.js' });
  return { context, values };
}

test('dashboard navigation restores only allowlisted tabs and bounded ticket identifiers', () => {
  const { context } = navigationContext();
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.parseDashboardNavigation(JSON.stringify({
      tab: 'tab-docs', modal: { type: 'ticket', id: 'tkt_abcdefghijklmnopqrstuv' }
    })))),
    { tab: 'tab-docs', modal: { type: 'ticket', id: 'tkt_abcdefghijklmnopqrstuv' } }
  );

  const invalidTab = context.parseDashboardNavigation(JSON.stringify({
    tab: 'tab-admin', modal: { type: 'ticket', id: 'tkt_abcdefghijklmnopqrstuv' }
  }));
  assert.equal(invalidTab.tab, 'tab-board');
  assert.equal(invalidTab.modal.type, 'ticket');

  const invalidId = context.parseDashboardNavigation(JSON.stringify({
    tab: 'tab-monitor', modal: { type: 'ticket', id: 'arbitrary-user-data' }
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(invalidId)), { tab: 'tab-monitor', modal: null });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.parseDashboardNavigation('x'.repeat(1025)))),
    { tab: 'tab-board', modal: null }
  );
});
