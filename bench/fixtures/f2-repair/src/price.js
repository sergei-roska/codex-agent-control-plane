'use strict';

function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

// pct is a whole-number percentage, e.g. 10 means 10 percent off.
function applyDiscount(total, pct) {
  return total - total * pct;
}

function withTax(total, rate) {
  return Math.round(total * (1 + rate) * 100) / 100;
}

module.exports = { subtotal, applyDiscount, withTax };
