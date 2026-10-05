'use strict';

// Shared retry policy for outbound work.
const DEFAULT_RETRY_LIMIT = 4;
const DEFAULT_BACKOFF_MS = 250;

module.exports = { DEFAULT_RETRY_LIMIT, DEFAULT_BACKOFF_MS };
