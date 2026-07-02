'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { isPortfolioGateEnabled } = require('./portfolioGateFlag');

test('isPortfolioGateEnabled — defaults to false when unset', () => {
  const prev = process.env.ENABLE_PORTFOLIO_GATE;
  delete process.env.ENABLE_PORTFOLIO_GATE;
  try {
    assert.strictEqual(isPortfolioGateEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.ENABLE_PORTFOLIO_GATE;
    else process.env.ENABLE_PORTFOLIO_GATE = prev;
  }
});

test('isPortfolioGateEnabled — false for any value other than the exact string "true"', () => {
  const prev = process.env.ENABLE_PORTFOLIO_GATE;
  try {
    for (const value of ['false', '1', 'TRUE', 'yes', '']) {
      process.env.ENABLE_PORTFOLIO_GATE = value;
      assert.strictEqual(isPortfolioGateEnabled(), false, `expected false for "${value}"`);
    }
  } finally {
    if (prev === undefined) delete process.env.ENABLE_PORTFOLIO_GATE;
    else process.env.ENABLE_PORTFOLIO_GATE = prev;
  }
});

test('isPortfolioGateEnabled — true when set to the exact string "true"', () => {
  const prev = process.env.ENABLE_PORTFOLIO_GATE;
  process.env.ENABLE_PORTFOLIO_GATE = 'true';
  try {
    assert.strictEqual(isPortfolioGateEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.ENABLE_PORTFOLIO_GATE;
    else process.env.ENABLE_PORTFOLIO_GATE = prev;
  }
});
