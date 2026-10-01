'use strict';

const { redactDiagnosticMessage } = require('../event-journal');

const ID_FIELDS = new Set(['ticketId', 'runId', 'attemptId', 'outcomeId', 'status']);

function redactValue(key, value) {
  if (typeof value !== 'string' || ID_FIELDS.has(key)) return value;
  return redactDiagnosticMessage(value);
}

function buildSanitizedTrace(fixture) {
  if (!fixture || fixture.version !== 'trace-v1') {
    throw new Error('unsupported trace fixture');
  }
  const ticket = fixture.ticket;
  const run = fixture.run;
  const attempt = fixture.attempt;
  const outcome = fixture.outcome;
  if (run.ticketId !== ticket.ticketId) throw new Error('run ticketId does not match ticket');
  if (attempt.runId !== run.runId) throw new Error('attempt runId does not match run');

  const correlation = {
    ticketId: ticket.ticketId,
    runId: run.runId,
    attemptId: attempt.attemptId,
    outcomeId: outcome.outcomeId,
  };
  return {
    traceId: `trace:${fixture.version}:${correlation.ticketId}:${correlation.runId}:${correlation.attemptId}`,
    fixtureVersion: fixture.version,
    correlation,
    ticket: {
      ticketId: ticket.ticketId,
      title: redactValue('title', ticket.title),
      text: redactValue('text', ticket.text),
    },
    run: {
      runId: run.runId,
      ticketId: run.ticketId,
    },
    attempt: {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      output: redactValue('output', attempt.output),
    },
    outcome: {
      outcomeId: outcome.outcomeId,
      status: outcome.status,
      feedback: redactValue('feedback', outcome.feedback),
    },
  };
}

module.exports = { buildSanitizedTrace };
