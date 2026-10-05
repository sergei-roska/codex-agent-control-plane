'use strict';

const retry = require('../config/retry');

function describeSync(name) {
  return `${name}: up to ${retry.DEFAULT_RETRY_LIMIT} retries`;
}

module.exports = { describeSync };
