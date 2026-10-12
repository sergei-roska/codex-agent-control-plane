'use strict';

// launcher-ui/app.js is a classic browser script with no exports, so these tests pull
// the LED functions out of its source and run them in a vm context with stubbed DOM.
// launcher-ui/styles.css is checked by selector presence only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..', 'launcher-ui');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

// Returns the source of a top-level (4-space indented) function declared in app.js.
function functionSource(name) {
  const start = APP_SRC.search(new RegExp('^ {4}function ' + name + '\\(', 'm'));
  assert.notEqual(start, -1, 'function ' + name + ' not found in app.js');
  const end = APP_SRC.indexOf('\n    }\n', start);
  assert.notEqual(end, -1, 'end of function ' + name + ' not found');
  return APP_SRC.slice(start, end + '\n    }\n'.length);
}

function loadLedFunctions(globals) {
  const src = ['teamLedState', 'updateTeamLeds', 'setTooltip', 'canonicalRoleId']
    .map(functionSource)
    .join('\n');
  const context = Object.assign({ LEGACY_ROLE_IDS: {} }, globals);
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

// Minimal DOM: one list with role rows, each row holding one LED span.
function fakeTeamList(roleIds) {
  const rows = roleIds.map(function (role) {
    const led = {
      dataset: {},
      attrs: {},
      classes: new Set(),
      classList: {
        toggle(name, force) {
          const on = force === undefined ? !led.classes.has(name) : Boolean(force);
          if (on) led.classes.add(name);
          else led.classes.delete(name);
          return on;
        },
        contains(name) { return led.classes.has(name); },
      },
      setAttribute(k, v) { led.attrs[k] = String(v); },
      removeAttribute(k) { delete led.attrs[k]; },
    };
    return {
      dataset: { role: role },
      querySelector(sel) { return sel === '.agent-led' ? led : null; },
      led: led,
    };
  });
  return {
    rows: rows,
    querySelectorAll(sel) { return sel === '.about-role' ? rows : []; },
  };
}

function ledState(row) {
  const { led } = row;
  return {
    active: led.classes.has('is-active'),
    available: led.classes.has('is-available'),
    unavailable: led.classes.has('is-unavailable'),
    label: led.attrs['aria-label'],
    tooltip: led.dataset.tooltip,
  };
}

// Runs updateTeamLeds against a shown session and returns each row's LED state by role.
function renderLeds(session, currentSessionId) {
  const list = fakeTeamList(['coordinator', 'architect', 'writer']);
  const ctx = loadLedFunctions({
    document: { getElementById: (id) => (id === 'aboutTeamList' ? list : null) },
    sessionData: session,
    currentSessionId: currentSessionId,
  });
  ctx.updateTeamLeds();
  const out = {};
  list.rows.forEach((row) => { out[row.dataset.role] = ledState(row); });
  return out;
}

const WORKING = 'TASK_STATE_WORKING';
const DONE = 'TASK_STATE_COMPLETED';

describe('teamLedState', () => {
  it('is idle before intake, whether or not a role is active', () => {
    const ctx = loadLedFunctions({});
    assert.equal(ctx.teamLedState(false, false), 'idle');
    assert.equal(ctx.teamLedState(false, true), 'idle');
  });

  it('is available for an idle role once the session has turns', () => {
    const ctx = loadLedFunctions({});
    assert.equal(ctx.teamLedState(true, false), 'available');
  });

  it('is active for a working role once the session has turns', () => {
    const ctx = loadLedFunctions({});
    assert.equal(ctx.teamLedState(true, true), 'active');
  });
});

describe('updateTeamLeds', () => {
  it('keeps the dark idle dot with label idle when no session is shown', () => {
    const leads = renderLeds({ turns: [] }, null);
    for (const role of Object.keys(leads)) {
      assert.equal(leads[role].active, false);
      assert.equal(leads[role].available, false);
      assert.equal(leads[role].label, 'idle');
      assert.equal(leads[role].tooltip, 'idle');
    }
  });

  it('keeps the idle state when the shown session has no turns yet', () => {
    const leads = renderLeds({ turns: [] }, 'sess-1');
    assert.equal(leads.architect.available, false);
    assert.equal(leads.architect.label, 'idle');
  });

  it('lights the working role as active and the rest as available', () => {
    const session = {
      turns: [{
        leadTask: { state: WORKING },
        workers: [{ role: 'architect', state: 'submitting' }],
      }],
    };
    const leads = renderLeds(session, 'sess-1');
    assert.deepEqual(
      { active: leads.architect.active, available: leads.architect.available, label: leads.architect.label, tooltip: leads.architect.tooltip },
      { active: true, available: false, label: 'active', tooltip: 'active' },
    );
    assert.equal(leads.writer.active, false);
    assert.equal(leads.writer.available, true);
    assert.equal(leads.writer.label, 'available');
    assert.equal(leads.writer.tooltip, 'available');
    assert.equal(leads.coordinator.available, true);
  });

  it('marks every role available when the latest turn is finished', () => {
    const session = {
      turns: [
        { leadTask: { state: WORKING }, workers: [{ role: 'architect', state: 'submitting' }] },
        { leadTask: { state: DONE }, workers: [] },
      ],
    };
    const leads = renderLeds(session, 'sess-1');
    for (const role of Object.keys(leads)) {
      assert.equal(leads[role].active, false, role);
      assert.equal(leads[role].available, true, role);
      assert.equal(leads[role].label, 'available', role);
    }
  });

  it('never sets is-unavailable (no trigger exists yet)', () => {
    const session = { turns: [{ leadTask: { state: WORKING }, workers: [] }] };
    const leads = renderLeds(session, 'sess-1');
    for (const role of Object.keys(leads)) {
      assert.equal(leads[role].unavailable, false, role);
    }
  });
});

describe('styles.css LED rules', () => {
  function ruleBody(selector) {
    const start = CSS_SRC.indexOf(selector + ' {');
    assert.notEqual(start, -1, selector + ' rule missing');
    return CSS_SRC.slice(start, CSS_SRC.indexOf('}', start));
  }

  it('defines available, active and unavailable LED states', () => {
    assert.match(ruleBody('.agent-led.is-available'), /background: rgba\(63, 182, 139, 0\.22\)/);
    assert.match(ruleBody('.agent-led.is-active'), /background: #74e8a8/);
    assert.match(ruleBody('.agent-led.is-active'), /animation: agent-led-pulse/);
    assert.match(ruleBody('.agent-led.is-unavailable'), /background: var\(--danger\)/);
  });

  it('keeps the unavailable LED without a pulse', () => {
    assert.doesNotMatch(ruleBody('.agent-led.is-unavailable'), /animation/);
  });

  it('keeps the active pulse disabled under reduced motion', () => {
    const start = CSS_SRC.indexOf('@media (prefers-reduced-motion: reduce)');
    assert.notEqual(start, -1);
    assert.match(CSS_SRC.slice(start), /\.agent-led\.is-active[\s\S]*animation: none/);
  });
});
