'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadPredicate(relativePath, name, constantName) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const constant = source.match(new RegExp(`^const ${constantName} = \\[[^\\n]+\\];$`, 'm'));
  const start = source.indexOf(`function ${name}(`);
  assert.ok(constant, `${constantName} should exist in ${relativePath}`);
  assert.notEqual(start, -1, `${name} should exist in ${relativePath}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, `${name} should have a complete body`);
  const context = {};
  vm.runInNewContext(`${constant[0]}\n${source.slice(start, end)}\nglobalThis.predicate = ${name};`, context);
  return context.predicate;
}

function loadFunction(relativePath, name, context = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in ${relativePath}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.notEqual(end, -1, `${name} should have a complete body`);
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.predicate = ${name};`, context);
  return context.predicate;
}

test('ticket run hides stale wait state after accept, cancel, or return to backlog', () => {
  const isVisible = loadPredicate('web/dashboard/js/modals/ticket-run.js', 'trrCurrentWaitVisible', 'TRR_INACTIVE_TICKET_STATUSES');
  const historicalReviewWait = { waitReason: 'human_review' };
  assert.equal(isVisible({ ticket: { status: 'waiting_human' } }, historicalReviewWait), true);
  assert.equal(isVisible({ ticket: { status: 'in_progress' } }, historicalReviewWait), true);
  for (const status of ['done', 'cancelled', 'backlog']) {
    assert.equal(isVisible({ ticket: { status } }, historicalReviewWait), false, status);
  }
  assert.equal(isVisible({ ticket: { status: 'waiting_human' } }, {}), false);

  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-run.js'), 'utf8');
  assert.match(source, /const showWait = trrCurrentWaitVisible\(d, run\)/);
  assert.match(source, /if \(showWait\) meta\.appendChild/);
  assert.match(source, /if \(showWait && wd && typeof wd === 'object'\)/);
  assert.match(source, /function trrLatestReview\(d\)/, 'latest review evidence remains rendered independently');
});

test('Board suppresses acceptance badges for cancelled and Draft tickets but keeps accepted evidence on Done', () => {
  const showDisposition = loadPredicate('web/dashboard/js/tabs/board.js', 'boardShowDisposition', 'BOARD_INACTIVE_TICKET_STATUSES');
  const accepted = { disposition: 'accepted' };
  assert.equal(showDisposition({ ...accepted, ticketStatus: 'waiting_human' }), true);
  assert.equal(showDisposition({ ...accepted, ticketStatus: 'in_progress' }), true);
  assert.equal(showDisposition({ ...accepted, ticketStatus: 'done' }), true);
  for (const ticketStatus of ['cancelled', 'backlog']) {
    assert.equal(showDisposition({ ...accepted, ticketStatus }), false, ticketStatus);
  }
  assert.equal(showDisposition({ ticketStatus: 'done' }), false);

  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/tabs/board.js'), 'utf8');
  assert.match(source, /if \(boardShowDisposition\(card\)\)/);
});

test('Backlog draft with a repository lease exposes only the release action', () => {
  const canRelease = loadFunction('web/dashboard/js/modals/ticket-run.js', 'trdReleaseOnlyShown', {
    trdAvailable: (detail, action) => (detail.availableActions || []).includes(action)
  });
  assert.equal(canRelease({ ticket: { status: 'backlog' }, availableActions: ['release_repository'] }), true);
  assert.equal(canRelease({ ticket: { status: 'backlog' }, availableActions: [] }), false);
  assert.equal(canRelease({ ticket: { status: 'done' }, availableActions: ['release_repository'] }), false);

  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-run.js'), 'utf8');
  assert.match(source, /if \(trdReleaseOnlyShown\(d\)\)\s*\{\s*trrGuard\('delivery',[\s\S]*?trdBuildReleaseOnly\(box, d\)/);
  const releaseOnly = source.match(/function trdBuildReleaseOnly\(el, d\) \{([\s\S]*?)\n\}/)[1];
  assert.match(releaseOnly, /trdAppendReleaseAction\(el, d\)/);
  assert.doesNotMatch(releaseOnly, /Commit|Push|history/i);
});

test('Accept and Submit errors render beside their initiating controls', () => {
  const runSource = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-run.js'), 'utf8');
  const submitReview = runSource.match(/async function trrSubmitReview\([\s\S]*?\n\}/)[0];
  assert.match(submitReview, /trr\.reviewError = m/);
  assert.match(submitReview, /renderRunPanel\(\)/);
  assert.match(runSource, /if \(trr\.reviewError\) el\.appendChild\(h\('div', \{ class: 'tf-field-error', text: trr\.reviewError, attrs: \{ role: 'alert' \} \}\)\)/);

  const recordSource = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-record.js'), 'utf8');
  const submit = recordSource.match(/async function submitTicketFromRecord\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(submit, /tr\.submitError = m/);
  const actions = recordSource.match(/function renderRecordActions\(d\) \{([\s\S]*?)\n\}/)[1];
  assert.match(actions, /if \(tr\.submitError\) box\.appendChild\(h\('div', \{ class: 'tf-field-error', text: tr\.submitError, attrs: \{ role: 'alert' \} \}\)\)/);
});

function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} has no complete body`);
}

function fakeButton(label, disabled = false) {
  const attrs = {};
  return {
    label, disabled, title: '', dataset: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
  };
}

test('ticket modal disables every mutating action while disconnected or after a failed load, then restores them', () => {
  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-record.js'), 'utf8');
  const selector = source.match(/^const TR_MUTATING_SELECTOR = .*;$/m)[0];
  const accept = fakeButton('accept');
  const corrections = fakeButton('corrections');
  const alreadyOff = fakeButton('push', true);
  alreadyOff.title = 'No remote';
  const buttons = [accept, corrections, alreadyOff];
  const note = { textContent: '', style: {}, parentNode: null };
  const context = {
    Conn: { status: 'connected' },
    tr: { loadFailed: false },
    document: {
      getElementById: (id) => (id === 'tr-lock-note' ? note : null),
      querySelectorAll: () => buttons,
    },
  };
  vm.runInNewContext(`${selector}\n${sliceFunction(source, 'trLockReason')}\n${sliceFunction(source, 'trApplyLock')}\nglobalThis.apply = trApplyLock;`, context);

  context.apply();
  assert.equal(accept.disabled, false);
  assert.equal(note.textContent, '');

  context.Conn.status = 'reconnecting';
  context.apply();
  for (const b of buttons) {
    assert.equal(b.disabled, true, b.label);
    assert.equal(b.getAttribute('aria-disabled'), 'true', b.label);
    assert.match(b.title, /not connected/, b.label);
  }
  assert.match(note.textContent, /not connected/);

  context.Conn.status = 'unpaired';
  context.apply();
  assert.match(note.textContent, /not paired/);

  context.Conn.status = 'connected';
  context.tr.loadFailed = true;
  context.apply();
  assert.equal(accept.disabled, true);
  assert.match(note.textContent, /could not be refreshed/);

  context.tr.loadFailed = false;
  context.apply();
  assert.equal(accept.disabled, false);
  assert.equal(corrections.disabled, false);
  assert.equal(accept.getAttribute('aria-disabled'), null);
  assert.equal(alreadyOff.disabled, true, 'a control the server marked unavailable stays disabled');
  assert.equal(alreadyOff.title, 'No remote');
  assert.equal(note.textContent, '');
});

test('Board labels its snapshot as stale while reconnecting or not paired', () => {
  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/tabs/board.js'), 'utf8');
  const context = { Conn: { status: 'connected' } };
  vm.runInNewContext(`${sliceFunction(source, 'boardStaleNote')}\nglobalThis.note = boardStaleNote;`, context);
  assert.equal(context.note(), '');
  context.Conn.status = 'reconnecting';
  assert.match(context.note(), /Reconnecting.*stale/);
  context.Conn.status = 'unpaired';
  assert.match(context.note(), /Not paired - data is stale/);
  assert.match(source, /boardData\.truncated, boardStaleNote\(\)/, 'the stale marker is part of the render signature');
  assert.match(sliceFunction(source, 'renderBoardStatusLine'), /boardStaleNote\(\)/);
});

test('connection state rendering refreshes the Board and ticket lock and reloads Connections once on return', () => {
  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/layout/sidebar.js'), 'utf8');
  const calls = [];
  const pane = { classList: { contains: () => pane.active }, active: true };
  const context = {
    formatClock: () => '',
    document: { getElementById: (id) => (id === 'tab-connections' ? pane : null) },
    renderBoard: () => calls.push('board'),
    trApplyLock: () => calls.push('lock'),
    loadConnections: () => calls.push('connections'),
  };
  vm.runInNewContext(`${source.match(/^let lastRenderedConnStatus = null;$/m)[0]}\n${sliceFunction(source, 'renderConnectionState')}\nglobalThis.render = renderConnectionState;`, context);

  context.render({ status: 'connecting' });
  context.render({ status: 'connected' });
  assert.ok(!calls.includes('connections'), 'first connect does not reload');
  context.render({ status: 'reconnecting' });
  assert.ok(!calls.includes('connections'));
  assert.ok(calls.includes('board') && calls.includes('lock'));
  context.render({ status: 'connected' });
  assert.equal(calls.filter(c => c === 'connections').length, 1);
  context.render({ status: 'connected' });
  assert.equal(calls.filter(c => c === 'connections').length, 1, 'reload happens once per return');
  context.render({ status: 'unpaired' });
  pane.active = false;
  context.render({ status: 'connected' });
  assert.equal(calls.filter(c => c === 'connections').length, 1, 'inactive tab is not reloaded');
});

test('ticket run renders non-blocking acceptance warnings as a note', () => {
  const lines = loadFunction('web/dashboard/js/modals/ticket-run.js', 'trrWarningLines');
  assert.deepEqual(JSON.parse(JSON.stringify(lines({ warnings: [{ code: 'reported_scope_mismatch', detail: 'Writer w1 reported: src/a.js' }] }))),
    ['Self-reported change not observed by the server: Writer w1 reported: src/a.js']);
  assert.equal(lines({ disposition: 'accepted' }).length, 0);
  assert.equal(lines(null).length, 0);
  const source = fs.readFileSync(path.join(root, 'web/dashboard/js/modals/ticket-run.js'), 'utf8');
  assert.match(source, /trrWarningLines\(acc\)/);
});

test('dashboard working copy shows skipped stages and the adaptive route block', () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  assert.match(read('web/dashboard/js/tabs/pipelines.js'), /PIPELINE_STAGE_STATUSES = \[[^\]]*'skipped'\]/);
  assert.match(read('web/dashboard/css/tabs/pipelines.css'), /\.badge-status\.skipped/);
  assert.match(read('web/dashboard/css/tabs/pipelines.css'), /\.pipeline-step\.skipped/);
  assert.match(read('web/dashboard/css/modals/ticket-run.css'), /\.tr-stage-skipped/);
  const run = read('web/dashboard/js/modals/ticket-run.js');
  assert.match(run, /function trrRouteBlock\(/);
  assert.match(run, /Promoted to full: /);
  assert.match(run, /Lead model calls skipped: /);
});
