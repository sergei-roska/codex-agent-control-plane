'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.handlers = {}; this.value = ''; this.disabled = false;
    this.clientWidth = 760; this._text = ''; this._html = ''; this.attributes = {};
    const classes = new Set(['hidden']);
    this.classList = { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x), toggle: (x, force) => (force === undefined ? !classes.has(x) : force) ? classes.add(x) : classes.delete(x) };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((x) => x.textContent || '').join(''); }
  set innerHTML(value) { this._html = String(value); this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(k, fn) { this.handlers[k] = fn; }
}
const elements = new Map();
const el = (id) => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
const project = 'aaaaaaaaaa'; const session = 'session-1';
const snapshot = {
  schema: 'task-metrics/v1', contextId: session, total: { totalTokens: 12, attempts: 2 },
  tasks: [{ taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', totalTokens: 12, inputTokens: 10, outputTokens: 2, attempts: 2, unknownTokenRows: 0, elapsedMs: 100 }]
};
const usage = {
  total: { totalTokens: null, attempts: 1 },
  performance: { schema: 'session-performance/v1', attempts: [
    { kind: 'worker_turn', taskId: 'worker-1', assignmentId: 'lead:r1:a0', role: 'engineer', tokens: { totalTokens: 4, inputTokens: 3, outputTokens: 1 }, elapsedMs: 40 }
  ] }
};
const document = { hidden: true, getElementById: el, createElement: (tag) => new Element(tag), createElementNS: (_ns, tag) => new Element(tag), addEventListener() {} };
const window = { location: { search: '?project=' + project + '&session=' + session, origin: 'http://localhost', href: 'http://localhost/ui/performance.html?project=' + project + '&session=' + session }, addEventListener() {} };
const base = '/api/projects/' + project + '/sessions/' + session;
const responses = {
  '/api/projects': { projects: [{ id: project, name: 'Project' }] },
  ['/api/projects/' + project + '/sessions']: { sessions: [{ contextId: session }] },
  ['/ui/metrics/' + project + '/' + session + '.json']: snapshot,
  [base + '/usage?details=performance']: usage,
};
const fetch = async (url) => { assert.ok(Object.hasOwn(responses, url), 'unexpected request ' + url); return { ok: true, json: async () => responses[url] }; };
const source = fs.readFileSync('launcher-ui/performance.js', 'utf8');
vm.runInNewContext(source, { document, window, history: { replaceState() {} }, fetch, URL, URLSearchParams, AbortController, setInterval: () => 1, clearInterval() {}, Date, Math, Number, String, Object, Array, Map, Set, JSON }, { filename: 'performance.js' });
(async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify({ row: el('taskRows').innerHTML, total: el('tokenTotal').textContent }));
  assert.match(el('taskRows').innerHTML, />12</, 'known snapshot value should survive an incomplete live overlay');
})().catch((error) => { console.error(error); process.exitCode = 1; });
