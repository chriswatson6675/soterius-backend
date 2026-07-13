'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { getBenchmarkOverlay } = require('./benchmark-overlay');

describe('TI-P-9 honest absence', () => {
  test('no comparator injected → null (no statistically valid benchmark currently exists)', async () => {
    const overlay = await getBenchmarkOverlay({ organisationId: 'ORG-1' });
    assert.strictEqual(overlay, null);
  });

  test('never throws — an Organisation with no cohort still resolves cleanly', async () => {
    await assert.doesNotReject(getBenchmarkOverlay({ organisationId: 'ORG-1' }));
  });

  test('a future comparator, when injected, is returned unlabelled (live: true is applied by projections.js, not here)', async () => {
    const overlay = await getBenchmarkOverlay({ organisationId: 'ORG-1' }, { compareToCohort: async () => ({ percentile: 55 }) });
    assert.deepStrictEqual(overlay, { percentile: 55 });
    assert.strictEqual(overlay.live, undefined);
  });
});
