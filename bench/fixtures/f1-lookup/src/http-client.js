'use strict';

const { DEFAULT_RETRY_LIMIT } = require('../config/retry');

async function fetchWithRetry(doFetch, limit = DEFAULT_RETRY_LIMIT) {
  let lastError;
  for (let attempt = 0; attempt <= limit; attempt += 1) {
    try {
      return await doFetch(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

module.exports = { fetchWithRetry };
