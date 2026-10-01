'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const Database = require('better-sqlite3');
const { EventJournal } = require('../src/event-journal');
const { projectMonitor } = require('../src/dashboard-projection');
const { createDashboardApi } = require('../src/dashboard-api');

const EMPTY_FILTERS = {
  category: { available: false, values: [] },
  severity: { available: false, values: [] },
  role: { available: false, values: [] },
};

function journalEvent(overrides = {}) {
  return {
    sequence: 1,
    occurredAt: '2026-10-01T10:00:00.000Z',
    type: 'run_submitted',
    role: 'architect',
    ticketId: 'tkt_1',
    payload: { message: 'queued for dispatch' },
    ...overrides,
  };
}

test('projectMonitor maps stored journal fields without inferring category or level', () => {
  const mapped = projectMonitor({
    ok: true,
    events: [
      journalEvent(),
      journalEvent({
        sequence: 2,
        type: 'writer_reconciled',
        role: 'system',
        ticketId: null,
        payload: {},
      }),
    ],
  });
  assert.equal(mapped.available, true);
  assert.equal(mapped.events[0].timestamp, '2026-10-01T10:00:00.000Z');
  assert.equal(mapped.events[0].category, 'run_submitted');
  assert.equal(mapped.events[0].role, 'architect');
  assert.equal(mapped.events[0].ticketId, 'tkt_1');
  assert.equal(mapped.events[0].message, 'queued for dispatch');
  assert.equal(mapped.events[0].level, null);
  assert.equal(mapped.events[1].category, 'writer_reconciled');
  assert.equal(mapped.events[1].role, 'system');
  assert.deepEqual(mapped.filters.category.values, ['run_submitted', 'writer_reconciled']);
  assert.equal(mapped.filters.severity.available, false);
  assert.deepEqual(mapped.filters.severity.values, []);
  assert.equal(mapped.filters.role.available, true);
  assert.deepEqual(mapped.filters.role.values, ['architect', 'system']);
  for (const forbidden of ['agent', 'info', 'warning', 'error']) {
    assert.equal(mapped.filters.category.values.includes(forbidden), false);
    assert.equal(mapped.filters.severity.values.includes(forbidden), false);
  }
});

test('projectMonitor keeps an explicit level and does not invent one', () => {
  const withLevel = projectMonitor({
    ok: true,
    events: [journalEvent({ level: 'error' }), journalEvent({ sequence: 2 })],
  });
  assert.deepEqual(withLevel.filters.severity.values, ['error']);
  assert.equal(withLevel.filters.severity.available, true);
  assert.equal(withLevel.events[0].level, 'error');
  assert.equal(withLevel.events[1].level, null);
});

test('empty successful read is available with no filter values', () => {
  const empty = projectMonitor({ ok: true, events: [] });
  assert.equal(empty.available, true);
  assert.deepEqual(empty.events, []);
  assert.equal(empty.filters.category.available, false);
  assert.equal(empty.filters.severity.available, false);
  assert.equal(empty.filters.role.available, false);
});

test('failed read is unavailable and does not throw', () => {
  let result;
  assert.doesNotThrow(() => { result = projectMonitor({ ok: false }); });
  assert.equal(result.available, false);
  assert.deepEqual(result.events, []);
});

test('GET /monitor reads the journal without mutating it', async (t) => {
  const db = new Database(':memory:');
  const events = new EventJournal({ db });
  events.ensureSchema();
  events.record('run_submitted', {
    ticketId: 'tkt_http',
    role: 'architect',
    payload: { message: 'http event' },
  });
  events.record('writer_reconciled', { role: 'system' });
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get().n;
  const before = count();
  const projection = { listCards: () => ({ cards: [] }) };
  const app = express();
  app.use(createDashboardApi({ projection, events, projectId: 'prj_test' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/monitor`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.events.length, 2);
  const first = body.events.find((event) => event.category === 'run_submitted');
  const second = body.events.find((event) => event.category === 'writer_reconciled');
  assert.equal(first.timestamp, first.timestamp);
  assert.ok(first.timestamp);
  assert.equal(first.role, 'architect');
  assert.equal(first.ticketId, 'tkt_http');
  assert.equal(first.message, 'http event');
  assert.equal(first.level, null);
  assert.equal(second.category, 'writer_reconciled');
  assert.equal(second.role, 'system');
  assert.equal(count(), before);
  const deleted = await fetch(`${origin}/monitor`, { method: 'DELETE' });
  assert.ok(deleted.status === 404 || deleted.status === 405);
  assert.equal(count(), before);
  const posted = await fetch(`${origin}/monitor`, { method: 'POST' });
  assert.ok(posted.status === 404 || posted.status === 405);
  assert.equal(count(), before);
  const again = await fetch(`${origin}/monitor`);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).events.length, 2);
  db.close();
  const unavailable = await fetch(`${origin}/monitor`);
  assert.equal(unavailable.status, 200);
  const failed = await unavailable.json();
  assert.equal(failed.available, false);
});

test('run_error diagnostic message redacts credentials on write and GET /monitor', async (t) => {
  const SECRET = 'LEAKME99';
  const leaky = [
    `clone failed https://user:${SECRET}@host/repo?token=${SECRET}`,
    `Authorization: Bearer ${SECRET}tok`,
    `model key sk-${SECRET}abcd`,
    'password=secret',
    'token=abc',
  ].join('\n');
  const db = new Database(':memory:');
  const events = new EventJournal({ db });
  events.ensureSchema();
  events.record('run_error', { runId: 'r-leak', payload: { message: leaky } });
  const stored = events.listByRun('r-leak');
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored[0].payload).includes(SECRET), false);
  assert.equal(JSON.stringify(stored[0].payload).includes('password=secret'), false);
  assert.equal(JSON.stringify(stored[0].payload).includes('token=abc'), false);
  assert.equal(JSON.stringify(stored[0].payload).includes('[REDACTED]'), true);
  const recent = events.listRecent();
  assert.equal(JSON.stringify(recent.events.map((event) => event.payload)).includes(SECRET), false);

  const rawProjected = projectMonitor({
    ok: true,
    events: [{
      sequence: 9,
      occurredAt: '2026-10-01T10:00:00.000Z',
      type: 'run_error',
      role: 'system',
      ticketId: null,
      payload: { message: leaky },
    }],
  });
  assert.equal(JSON.stringify(rawProjected).includes(SECRET), false);
  assert.equal(
    projectMonitor({ ok: true, events: [journalEvent()] }).events[0].message,
    'queued for dispatch',
  );

  const app = express();
  app.use(createDashboardApi({
    projection: { listCards: () => ({ cards: [] }) },
    events,
    projectId: 'prj_test',
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(() => { try { db.close(); } catch (_) {} resolve(); })));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/monitor`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

function createDocument() {
  const byId = new Map();
  const all = [];

  class El {
    constructor(tag) {
      this.tagName = String(tag).toLowerCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.className = '';
      this._text = '';
      this.disabled = false;
      this._value = '';
      this.dataset = {};
      this.listeners = {};
      this.id = '';
      this.title = '';
      all.push(this);
    }

    get textContent() {
      if (this.children.length) return this.children.map((child) => child.textContent).join('');
      return this._text;
    }

    set textContent(value) {
      this.children = [];
      this._text = value == null ? '' : String(value);
    }

    setAttribute(name, value) {
      const text = String(value);
      this.attributes[name] = text;
      if (name === 'id') {
        this.id = text;
        byId.set(text, this);
      }
      if (name === 'value') this._value = text;
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[key] = text;
      }
    }

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.id) byId.set(child.id, child);
      return child;
    }

    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    }

    get value() {
      if (this.tagName === 'select') {
        const match = this.children.find((child) => child._value === this._value);
        const selected = match || this.children[0];
        return selected ? selected._value : this._value;
      }
      return this._value;
    }

    set value(next) {
      this._value = String(next);
    }

    click() {
      (this.listeners.click || []).forEach((fn) => fn({ type: 'click', target: this }));
    }
  }

  function option(id, value, text, disabled) {
    const select = new El('select');
    select.id = id;
    select.disabled = Boolean(disabled);
    byId.set(id, select);
    const opt = new El('option');
    opt.setAttribute('value', value);
    opt.textContent = text;
    select.appendChild(opt);
    select.value = value;
    return select;
  }

  const root = new El('div');
  root.appendChild(option('monitor-type-filter', 'all', 'All categories', true));
  root.appendChild(option('monitor-role-filter', 'all', 'Role filter unavailable', true));
  root.appendChild(option('monitor-level-filter', 'all', 'Severity unavailable', true));
  const btn = new El('button');
  btn.id = 'btn-clear-logs';
  byId.set('btn-clear-logs', btn);
  const status = new El('div');
  status.id = 'monitor-status';
  status.className = 'detail-empty';
  byId.set('monitor-status', status);
  const logs = new El('div');
  logs.id = 'monitor-logs';
  byId.set('monitor-logs', logs);

  return {
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => new El(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
  };
}

function loadMonitorUi() {
  const document = createDocument();
  const context = {
    document,
    state: { activeTab: 'tab-monitor' },
    console,
    apiGet: async () => { throw new Error('apiGet not stubbed'); },
  };
  vm.createContext(context);
  const root = path.join(__dirname, '..', 'web', 'dashboard', 'js');
  vm.runInContext(fs.readFileSync(path.join(root, 'util.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'tabs', 'monitor.js'), 'utf8'), context);
  context.initMonitorEvents();
  return context;
}

function optionValues(select) {
  return select.children.map((child) => child.getAttribute('value'));
}

function changeSelect(select, value) {
  select.value = value;
  (select.listeners.change || []).forEach((fn) => fn({ type: 'change', target: select }));
}

test('monitor UI renders journal events, clears the client buffer, and keeps last success', async () => {
  const ctx = loadMonitorUi();
  const snapshot = projectMonitor({
    ok: true,
    events: [
      journalEvent({
        sequence: 4,
        occurredAt: '2026-10-01T12:00:00.000Z',
        type: 'run_submitted',
        role: 'architect',
        ticketId: 'tkt_ui',
        payload: { message: 'visible row' },
      }),
    ],
  });
  ctx.applyMonitorSnapshot(snapshot);
  const logs = ctx.document.getElementById('monitor-logs');
  const lineText = logs.textContent;
  const timeNode = logs.children[0] && logs.children[0].children[0];
  assert.equal(timeNode && timeNode.getAttribute('data-timestamp'), '2026-10-01T12:00:00.000Z');
  assert.match(lineText, /run_submitted/);
  assert.match(lineText, /\[architect\]/);
  assert.match(lineText, /tkt_ui/);
  assert.match(lineText, /visible row/);
  assert.match(lineText, /unavailable/);
  const typeFilter = ctx.document.getElementById('monitor-type-filter');
  assert.deepEqual(optionValues(typeFilter), ['all', 'run_submitted']);
  assert.equal(optionValues(typeFilter).includes('agent'), false);
  assert.equal(optionValues(typeFilter).includes('system'), false);
  const levelFilter = ctx.document.getElementById('monitor-level-filter');
  assert.equal(levelFilter.disabled, true);
  for (const forbidden of ['info', 'warning', 'error']) {
    assert.equal(optionValues(levelFilter).includes(forbidden), false);
  }
  const roleFilter = ctx.document.getElementById('monitor-role-filter');
  assert.equal(roleFilter.disabled, false);
  assert.deepEqual(optionValues(roleFilter), ['all', 'architect']);

  let apiCalls = 0;
  ctx.apiGet = async function () {
    apiCalls += 1;
    throw new Error('should not be called by clear');
  };
  const beforeLen = ctx.monitorView.events.length;
  ctx.document.getElementById('btn-clear-logs').click();
  assert.equal(logs.children.length, 0);
  assert.match(ctx.document.getElementById('monitor-status').textContent, /cleared/);
  assert.match(ctx.document.getElementById('monitor-status').textContent, /Durable journal records are unchanged/);
  assert.equal(apiCalls, 0);
  assert.equal(ctx.monitorView.events.length, beforeLen);

  ctx.applyMonitorSnapshot({ available: true, events: [], filters: EMPTY_FILTERS });
  assert.equal(logs.children.length, 0);
  assert.match(ctx.document.getElementById('monitor-status').textContent, /No correlated events yet/);

  ctx.applyMonitorSnapshot({ available: false, reason: 'disk read failed' });
  assert.match(ctx.document.getElementById('monitor-status').textContent, /Events unavailable: disk read failed/);

  ctx.monitorView.clearedThrough = 0;
  ctx.applyMonitorSnapshot(snapshot);
  assert.ok(logs.children.length > 0);
  ctx.apiGet = async function () {
    apiCalls += 1;
    throw new Error('transport down');
  };
  await assert.rejects(() => ctx.refreshMonitorIfVisible(), /transport down/);
  assert.ok(logs.children.length > 0);
  assert.match(logs.textContent, /visible row/);
  assert.match(ctx.document.getElementById('monitor-status').textContent, /Events unavailable: transport down/);
  assert.match(ctx.document.getElementById('monitor-status').textContent, /last successful snapshot/);
});

test('monitor role filter uses provided roles and preserves selection across snapshots and clear', () => {
  const ctx = loadMonitorUi();
  const logs = ctx.document.getElementById('monitor-logs');
  const roleFilter = ctx.document.getElementById('monitor-role-filter');
  const firstSnapshot = projectMonitor({
    ok: true,
    events: [
      journalEvent({ sequence: 1, role: 'architect' }),
      journalEvent({ sequence: 2, role: 'writer' }),
      journalEvent({ sequence: 3, role: null }),
    ],
  });

  ctx.applyMonitorSnapshot(firstSnapshot);
  assert.equal(roleFilter.disabled, false);
  assert.deepEqual(optionValues(roleFilter), ['all', 'architect', 'writer']);
  changeSelect(roleFilter, 'writer');
  assert.equal(logs.children.length, 1);
  assert.match(logs.textContent, /\[writer\]/);
  assert.doesNotMatch(logs.textContent, /\[architect\]/);

  ctx.applyMonitorSnapshot(projectMonitor({
    ok: true,
    events: [
      journalEvent({ sequence: 4, role: 'architect' }),
      journalEvent({ sequence: 5, role: 'writer' }),
    ],
  }));
  assert.equal(roleFilter.value, 'writer');
  assert.equal(logs.children.length, 1);
  assert.match(logs.textContent, /\[writer\]/);

  ctx.clearMonitorBuffer();
  assert.equal(roleFilter.value, 'writer');
  assert.equal(logs.children.length, 0);

  ctx.applyMonitorSnapshot(projectMonitor({ ok: true, events: [journalEvent({ sequence: 6, role: null })] }));
  assert.equal(roleFilter.disabled, true);
  assert.equal(optionValues(roleFilter)[0], 'all');
  assert.match(roleFilter.children[0].textContent, /Role filter unavailable/);
});
