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

  const workers = db.prepare("SELECT role, state, task_id, updated_at FROM dispatch_journal WHERE run_id = ? ORDER BY created_at ASC").all(lead.id);

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
    workers
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

function getSession(db, contextId) {
  const rows = sessionRows(db, contextId);
  if (rows.length === 0) return null;
  return { contextId, turns: rows.map(row => formatLeadTask(db, row)) };
}

function deleteLeadTask(db, taskId) {
  const deleteTx = db.transaction(() => {
    const workers = db.prepare("SELECT task_id FROM dispatch_journal WHERE run_id = ?").all(taskId).map(r => r.task_id);
    if (workers.length > 0) {
      const placeholders = workers.map(() => '?').join(',');
      db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...workers);
      try { db.prepare(`DELETE FROM writer_executions WHERE task_id IN (${placeholders})`).run(...workers); } catch (_) {}
    }
    db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    db.prepare("DELETE FROM dispatch_journal WHERE run_id = ?").run(taskId);
    try { db.prepare("DELETE FROM checkpoints WHERE thread_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM writes WHERE thread_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM usage_ledger WHERE run_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM evidence WHERE run_id = ?").run(taskId); } catch (_) {}
    try { db.prepare("DELETE FROM writer_executions WHERE task_id = ?").run(taskId); } catch (_) {}
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
  deleteLeadTask,
  deleteSession,
};
