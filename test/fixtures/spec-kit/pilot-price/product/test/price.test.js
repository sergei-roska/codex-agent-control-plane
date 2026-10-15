'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { subtotal, applyDiscount, withTax } = require('../src/price');

test('subtotal sums price times quantity', () => {
  assert.strictEqual(subtotal([{ price: 5, qty: 2 }, { price: 3, qty: 1 }]), 13);
});

test('applyDiscount takes a whole-number percentage off', () => {
  assert.strictEqual(applyDiscount(200, 10), 180);
});

test('applyDiscount with zero percent is a no-op', () => {
  assert.strictEqual(applyDiscount(200, 0), 200);
});

test('withTax rounds to cents', () => {
  assert.strictEqual(withTax(10, 0.075), 10.75);
});
