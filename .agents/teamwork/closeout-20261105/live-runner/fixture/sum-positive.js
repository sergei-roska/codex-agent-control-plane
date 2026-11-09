'use strict';

function sumPositive(values) {
  return values.reduce((total, value) => total + value, 0);
}

module.exports = { sumPositive };
