'use strict';

const { DEFAULT_RETRY_LIMIT } = require('../config/retry');

function shouldRequeue(job) {
  return (job.attempts || 0) < DEFAULT_RETRY_LIMIT;
}

module.exports = { shouldRequeue };
