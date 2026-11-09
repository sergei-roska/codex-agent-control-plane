'use strict';

function report(label, values) {
  return { label, total: values.length };
}

module.exports = { report };
