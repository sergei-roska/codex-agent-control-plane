'use strict';

// Session = A2A contextId. Pure helpers over a better-sqlite3 handle to a project state DB.
// Lead tasks are rows of the SDK `tasks` table with owner = 'orchestrator'.

const TERMINAL_STATES = ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'];

class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
  }
}

function firstText(message) {
  for (const part of (message && message.parts) || []) {
    const text = part.text || part.content?.value;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

function hasLiveActivity(db) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'live_activity'").get());
  } catch (_) {
    return false;
  }
}

// Returns key => null | { phase, summary, startedAt, updatedAt, endedAt, commands, fileChanges }.
// Never throws: a missing table (older DB, server not restarted) yields null.
function activityReader(db) {
  if (!hasLiveActivity(db)) return () => null;
  let stmt;
  try {
    stmt = db.prepare('SELECT phase, summary, started_at, updated_at, ended_at, commands, file_changes FROM live_activity WHERE key = ?');
  } catch (_) {
    return () => null;
  }
  return (key) => {
    if (!key) return null;
    try {
      const r = stmt.get(key);
      if (!r) return null;
      return {
        phase: r.phase,
        summary: r.summary || '',
        startedAt: r.started_at,
        updatedAt: r.updated_at,
        endedAt: r.ended_at || null,
        commands: r.commands || 0,
        fileChanges: r.file_changes || 0
      };
    } catch (_) {
      return null;
    }
  };
}

// Assignment objective of a worker: the lead sends the assignment as a JSON text part of the
// worker task's first user message. Falls back to the first 160 chars of the text. Never throws.
function workerObjective(db, taskId) {
  if (!taskId) return null;
  try {
    const row = db.prepare('SELECT history FROM tasks WHERE id = ?').get(taskId);
    if (!row || !row.history) return null;
    const msgs = JSON.parse(row.history);
    const first = msgs.find(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
    const text = firstText(first);
    if (!text) return null;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.objective === 'string' && parsed.objective.trim()) {
          return parsed.objective.trim().slice(0, 300);
        }
      } catch (_) {}
    }
    return text.slice(0, 160);
  } catch (_) {
    return null;
  }
}

function roundOf(assignmentId) {
  const m = /:r(\d+):/.exec(String(assignmentId || ''));
  return m ? Number(m[1]) : null;
}

function workerTaskState(db, taskId) {
  try {
    const row = db.prepare('SELECT status_state FROM tasks WHERE id = ?').get(taskId);
    return row && row.status_state ? row.status_state : null;
  } catch (_) {
    return null;
  }
}

function formatLeadTask(db, lead) {
  let goal = '';
  let lastInstruction = '';
  let continuesFrom = '';
  if (lead.history) {
    try {
      const history = JSON.parse(lead.history);
      const userMsgs = history.filter(m => m.role === 'ROLE_USER' || m.role === 1 || m.role === 'user');
      if (userMsgs.length > 0) {
        const firstMsg = userMsgs[0];
        if (Array.isArray(firstMsg.referenceTaskIds) && typeof firstMsg.referenceTaskIds[0] === 'string') {
          continuesFrom = firstMsg.referenceTaskIds[0];
        }
        goal = firstText(firstMsg);
        if (userMsgs.length > 1) {
          lastInstruction = firstText(userMsgs[userMsgs.length - 1]);
        }
      }
    } catch (_) {}
  }

  const rows = db.prepare("SELECT role, state, task_id, assignment_id, created_at, updated_at FROM dispatch_journal WHERE run_id = ? ORDER BY created_at ASC").all(lead.id);
  const activity = activityReader(db);
  const workers = rows.map(w => {
    const active = w.state === 'submitting' || w.state === 'submitted';
    return {
      ...w,
      round: roundOf(w.assignment_id),
      taskState: active ? undefined : workerTaskState(db, w.task_id),
      objective: active ? workerObjective(db, w.task_id) : null,
      activity: activity(w.task_id)
    };
  });

  return {
    leadTask: {
      id: lead.id,
      goal: goal || null,
      lastInstruction: lastInstruction || null,
      continuesFrom: continuesFrom || null,
      state: lead.status_state,
      status: lead.status ? JSON.parse(lead.status) : null,
      artifacts: lead.artifacts ? JSON.parse(lead.artifacts) : [],
      metadata: lead.metadata ? JSON.parse(lead.metadata) : {},
      updatedAt: lead.status_last_updated
    },
    workers,
    leadActivity: activity('lead:' + lead.id)
  };
}

function sessionKey(row) {
  return row.context_id || row.id;
}

function dispositionOf(row) {
  if (!row.artifacts) return null;
  try {
    const arts = JSON.parse(row.artifacts);
    return arts?.at(-1)?.metadata?.acceptance?.disposition || null;
  } catch (_) {
    return null;
  }
}

function listSessions(db) {
  const rows = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' ORDER BY status_last_updated ASC, id ASC").all();
  const groups = new Map();
  for (const row of rows) {
    const key = sessionKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const sessions = [];
  for (const [contextId, turns] of groups) {
    const first = turns[0];
    const last = turns[turns.length - 1];
    sessions.push({
      contextId,
      goal: formatLeadTask(db, first).leadTask.goal || '(no description)',
      turns: turns.length,
      state: last.status_state,
      updatedAt: last.status_last_updated,
      lastTaskId: last.id,
      disposition: dispositionOf(last),
    });
  }
  sessions.sort((a, b) => (b.updatedAt - a.updatedAt) || (a.lastTaskId < b.lastTaskId ? 1 : -1));
  return sessions;
}

function sessionRows(db, contextId) {
  if (!contextId) return [];
  const rows = db.prepare(
    "SELECT * FROM tasks WHERE owner = 'orchestrator' AND context_id = ? ORDER BY status_last_updated ASC, id ASC"
  ).all(contextId);
  if (rows.length > 0) return rows;
  const single = db.prepare("SELECT * FROM tasks WHERE owner = 'orchestrator' AND id = ? AND context_id = ''").get(contextId);
  return single ? [single] : [];
}

// Lead task ids of a session in the order getSession lists its turns.
function sessionLeadTaskIds(db, contextId) {
  return sessionRows(db, contextId).map(row => row.id);
}

function getSession(db, contextId) {
  const rows = sessionRows(db, contextId);
  if (rows.length === 0) return null;
  return { contextId, turns: rows.map(row => formatLeadTask(db, row)) };
}

function deleteLeadTask(db, taskId) {
  const deleteTx = db.transaction(() => {
    const workers = db.prepare("SELECT task_id FROM dispatch_journal WHERE run_id = ?").all(taskId).map(r => r.task_id);
    const relatedTaskIds = [...new Set([taskId, ...workers].filter(Boolean))];
    const hasWriterExecutions = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'writer_executions'"
    ).get();
    if (hasWriterExecutions && relatedTaskIds.length > 0) {
      const placeholders = relatedTaskIds.map(() => '?').join(',');
      const executions = db.prepare(
        `SELECT state FROM writer_executions WHERE task_id IN (${placeholders})`
      ).all(...relatedTaskIds);
      if (executions.some(row => row.state !== 'released' && row.state !== 'reconciled')) {
        throw new SessionError(
          'writer_execution_unresolved',
          'Cannot delete a session with an active or unresolved writer execution!',
        );
      }
      db.prepare(
        `DELETE FROM writer_executions WHERE task_id IN (${placeholders}) AND state IN ('released', 'reconciled')`
      ).run(...relatedTaskIds);
    }
    const hasWriterLanes = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'writer_lanes'"
    ).get();
    if (hasWriterLanes && relatedTaskIds.length > 0) {
      const placeholders = relatedTaskIds.map(() => '?').join(',');
      const live = db.prepare(
        `SELECT 1 FROM writer_lanes WHERE task_id IN (${placeholders}) AND state IN ('preparing', 'prepared', 'running', 'integrating') LIMIT 1`
      ).get(...relatedTaskIds);
      if (live) {
        throw new SessionError(
          'writer_lane_active',
          'Cannot delete a session with an active writer lane!',
        );
      }
    }
    if (hasLiveActivity(db)) {
      const keys = [...workers.filter(Boolean), 'lead:' + taskId];
      db.prepare(`DELETE FROM live_activity WHERE key IN (${keys.map(() => '?').join(',')})`).run(...keys);
    }
    if (workers.length > 0) {
      const placeholders = workers.map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...workers);
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("DELETE FROM dispatch_journal WHERE run_id = ?").run(taskId);
    try { db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM writes WHERE thread_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM usage_ledger WHERE run_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM evidence WHERE run_id = ?").run(taskId); } catch (_) {}
  });
  deleteTx();
}

// Deletes every turn of a session in one transaction. Returns the deleted task ids.
function deleteSession(db, contextId) {
  const tx = db.transaction(() => {
    const rows = sessionRows(db, contextId);
    if (rows.length === 0) throw new SessionError('not_found', 'Session not found');
    if (rows.some(row => !TERMINAL_STATES.includes(row.status_state))) {
      throw new SessionError('not_terminal', 'Cannot delete a session with an active turn!');
    }
    for (const row of rows) deleteLeadTask(db, row.id);
    return rows.map(row => row.id);
  });
  return tx();
}

module.exports = {
  SessionError,
  TERMINAL_STATES,
  formatLeadTask,
  listSessions,
  getSession,
  sessionLeadTaskIds,
  deleteLeadTask,
  deleteSession,
};
