'use strict';

// Live activity of running Codex turns in the shared state database (table live_activity). The
// server records what each worker or lead turn is doing right now; the launcher process only
// reads it. Everything here is best effort: a failing write never reaches a run.

const WRITE_INTERVAL_MS = 2000;
const MAX_SUMMARY = 200;

function createActivityTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_activity (
      key TEXT PRIMARY KEY,
      run_id TEXT,
      role TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      phase TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      commands INTEGER NOT NULL DEFAULT 0,
      file_changes INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function oneLine(value, max = MAX_SUMMARY) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// Code mode runs commands through a custom tool whose input is JS source calling
// tools.exec_command({cmd: "..."}); pull out the first cmd string literal.
const CMD_LITERAL = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/;
function codeModeCommand(value, depth = 0) {
  if (value && typeof value === 'object' && depth < 3) {
    for (const inner of Object.values(value)) {
      const found = codeModeCommand(inner, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const match = typeof value === 'string' ? CMD_LITERAL.exec(value) : null;
  if (!match) return '';
  const literal = match[1];
  if (literal[0] === '"') {
    try { return JSON.parse(literal); } catch (_) { /* fall through to the raw text */ }
  }
  return literal.slice(1, -1);
}

function itemTool(item) {
  return typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : '';
}

function changedPaths(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.map((change) => (typeof change?.path === 'string' ? change.path : '')).filter(Boolean).join(', ');
}

function commandOf(item) {
  if (typeof item.command === 'string') return item.command;
  if (Array.isArray(item.command)) {
    const parts = item.command.filter((part) => typeof part === 'string');
    if (parts.length === 3 && (parts[1] === '-lc' || parts[1] === '-c')) return parts[2];
    return parts.join(' ');
  }
  return codeModeCommand(item.arguments ?? item.input);
}

// Pure mapping of one item/started or item/completed item onto { phase, summary, ... }.
function startedState(item) {
  switch (item.type) {
    case 'commandExecution': return { phase: 'command', summary: oneLine(commandOf(item)) };
    case 'fileChange': return { phase: 'editing', summary: oneLine(changedPaths(item)) };
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'customToolCall':
    case 'custom_tool_call': {
      const tool = itemTool(item);
      const cmd = codeModeCommand(item.arguments ?? item.input);
      if (cmd) return { phase: 'command', summary: oneLine(cmd) };
      return { phase: 'tool', summary: oneLine(tool || item.type) };
    }
    case 'reasoning': return { phase: 'thinking', summary: '' };
    case 'agentMessage': return { phase: 'reporting', summary: '' };
    default: {
      const cmd = itemTool(item) ? codeModeCommand(item.arguments ?? item.input) : '';
      if (cmd) return { phase: 'command', summary: oneLine(cmd) };
      return { phase: 'tool', summary: oneLine(itemTool(item) || (typeof item.type === 'string' ? item.type : '')) };
    }
  }
}

class ActivityStore {
  constructor({
    db, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = WRITE_INTERVAL_MS,
  } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('ActivityStore requires a sqlite db');
    this.db = db;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervalMs = intervalMs;
    this.tracked = new Map(); // key -> current tracker state
    createActivityTable(db);
    this.upsert = db.prepare(`
      INSERT INTO live_activity (key, run_id, role, started_at, updated_at, ended_at, phase, summary, commands, file_changes)
      VALUES (@key, @runId, @role, @startedAt, @updatedAt, @endedAt, @phase, @summary, @commands, @fileChanges)
      ON CONFLICT(key) DO UPDATE SET run_id = excluded.run_id, role = excluded.role, started_at = excluded.started_at,
        updated_at = excluded.updated_at, ended_at = excluded.ended_at, phase = excluded.phase,
        summary = excluded.summary, commands = excluded.commands, file_changes = excluded.file_changes
    `);
  }

  _iso() {
    return new Date(this.now()).toISOString();
  }

  _write(state) {
    if (state.timer) {
      try { this.clearTimer(state.timer); } catch (_) { /* best effort */ }
      state.timer = null;
    }
    state.dirty = false;
    state.lastWriteMs = this.now();
    try {
      this.upsert.run({
        key: state.key,
        runId: state.runId,
        role: state.role,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        endedAt: state.endedAt,
        phase: state.phase,
        summary: state.summary,
        commands: state.commands,
        fileChanges: state.fileChanges,
      });
    } catch (_) { /* Activity is advisory; a locked or broken database must not affect the run. */ }
  }

  _schedule(state) {
    state.dirty = true;
    if (state.timer) return;
    const wait = state.lastWriteMs + this.intervalMs - this.now();
    if (wait <= 0) {
      this._write(state);
      return;
    }
    try {
      state.timer = this.setTimer(() => {
        state.timer = null;
        if (state.dirty && this.tracked.get(state.key) === state) this._write(state);
      }, wait);
      state.timer?.unref?.();
    } catch (_) { state.timer = null; }
  }

  // Start (or restart, for a reused key) a turn. Returns { observe(event), end(outcome) }.
  begin({ key, runId = null, role } = {}) {
    const noop = { observe() {}, end() {} };
    try {
      if (typeof key !== 'string' || !key) return noop;
      const previous = this.tracked.get(key);
      if (previous) {
        previous.ended = true; // a superseded turn can no longer write this key
        if (previous.timer) { try { this.clearTimer(previous.timer); } catch (_) { /* best effort */ } }
      }
      const iso = this._iso();
      const state = {
        key,
        runId: typeof runId === 'string' && runId ? runId : null,
        role: typeof role === 'string' && role ? role : 'unknown',
        startedAt: iso,
        updatedAt: iso,
        endedAt: null,
        phase: 'starting',
        summary: '',
        commands: 0,
        fileChanges: 0,
        timer: null,
        dirty: false,
        lastWriteMs: 0,
        ended: false,
      };
      this.tracked.set(key, state);
      this._write(state);
      return {
        observe: (event) => this._observe(state, event),
        end: (outcome) => this._end(state, outcome),
      };
    } catch (_) {
      return noop;
    }
  }

  _observe(state, event) {
    try {
      if (state.ended || !event || typeof event !== 'object') return;
      state.updatedAt = this._iso();
      const params = event.params && typeof event.params === 'object' ? event.params : {};
      const item = params.item && typeof params.item === 'object' ? params.item : null;
      if (event.method === 'turn/started') {
        state.phase = 'thinking';
        state.summary = '';
      } else if (event.method === 'item/started' && item) {
        const next = startedState(item);
        state.phase = next.phase;
        state.summary = next.summary;
      } else if (event.method === 'item/completed' && item) {
        if (item.type === 'commandExecution') {
          state.commands += 1;
          const exit = item.exitCode != null ? `exit ${item.exitCode}` : '';
          const secs = Number.isFinite(item.durationMs) ? `${(item.durationMs / 1000).toFixed(1)}s` : '';
          const tail = [exit, secs].filter(Boolean).join(', ');
          const command = oneLine(commandOf(item), MAX_SUMMARY - (tail ? tail.length + 3 : 0));
          state.summary = command ? (tail ? `${command} (${tail})` : command) : state.summary;
        } else if (item.type === 'fileChange') {
          state.fileChanges += 1;
        }
        state.phase = 'thinking';
      }
      this._schedule(state);
    } catch (_) { /* never into a run */ }
  }

  _end(state, outcome) {
    try {
      if (state.ended) return;
      state.ended = true;
      if (state.timer) { try { this.clearTimer(state.timer); } catch (_) { /* best effort */ } state.timer = null; }
      const iso = this._iso();
      state.updatedAt = iso;
      state.endedAt = iso;
      state.phase = 'done';
      state.summary = oneLine(typeof outcome === 'string' ? outcome : state.summary);
      this._write(state);
      if (this.tracked.get(state.key) === state) this.tracked.delete(state.key);
    } catch (_) { /* never into a run */ }
  }
}

function createActivityStore(db, options = {}) {
  return new ActivityStore({ db, ...options });
}

module.exports = {
  ActivityStore, createActivityStore, createActivityTable, startedState, codeModeCommand, WRITE_INTERVAL_MS,
};
