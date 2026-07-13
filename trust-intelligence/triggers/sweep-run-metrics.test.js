'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { recordCompletedRun, recordCrashedRun, getRecentRuns } = require('./sweep-run-metrics');

function fakeClient(captureTable) {
  return {
    from(table) {
      return {
        insert: async (row) => { captureTable.table = table; captureTable.row = row; return { error: null }; },
        select: () => ({
          order: () => ({
            limit: async () => ({ data: [{ id: '1' }], error: null }),
          }),
        }),
      };
    },
  };
}

describe('recordCompletedRun', () => {
  test('inserts a row with duration/counts derived from the sweep result and the supplied population total', async () => {
    const captured = {};
    const result = {
      processed: [{ organisationId: 'ORG-1' }],
      skipped: [{ organisationId: 'ORG-2', reason: 'x' }],
      failed: [{ organisationId: 'ORG-3', reason: 'boom' }],
    };
    await recordCompletedRun({
      startedAt: '2026-07-13T00:00:00.000Z',
      completedAt: '2026-07-13T00:00:05.000Z',
      policyThresholdMs: 86400000,
      populationTotal: 10,
      result,
    }, { client: fakeClient(captured) });

    assert.strictEqual(captured.table, 'trust_intelligence_sweep_runs');
    assert.strictEqual(captured.row.duration_ms, 5000);
    assert.strictEqual(captured.row.population_total, 10);
    assert.strictEqual(captured.row.processed_count, 1);
    assert.strictEqual(captured.row.skipped_count, 1);
    assert.strictEqual(captured.row.failed_count, 1);
    assert.deepStrictEqual(captured.row.failed_organisation_ids, ['ORG-3']);
    assert.strictEqual(captured.row.outcome, 'completed');
  });

  test('throws a clear error if the insert fails', async () => {
    const client = { from: () => ({ insert: async () => ({ error: { message: 'db down' } }) }) };
    await assert.rejects(
      recordCompletedRun({
        startedAt: '2026-07-13T00:00:00.000Z', completedAt: '2026-07-13T00:00:01.000Z',
        policyThresholdMs: 1, populationTotal: 0, result: { processed: [], skipped: [], failed: [] },
      }, { client }),
      /trust_intelligence_sweep_runs insert failed: db down/,
    );
  });
});

describe('recordCrashedRun', () => {
  test('inserts an outcome=crashed row with zeroed counts and the crash reason', async () => {
    const captured = {};
    await recordCrashedRun({
      startedAt: '2026-07-13T00:00:00.000Z',
      crashedAt: '2026-07-13T00:00:02.000Z',
      policyThresholdMs: 1,
      reason: 'policyThresholdMs must be a positive, finite number',
    }, { client: fakeClient(captured) });

    assert.strictEqual(captured.row.outcome, 'crashed');
    assert.strictEqual(captured.row.duration_ms, 2000);
    assert.strictEqual(captured.row.processed_count, 0);
    assert.strictEqual(captured.row.crash_reason, 'policyThresholdMs must be a positive, finite number');
  });
});

describe('getRecentRuns', () => {
  test('returns rows newest-first, defaulting to a limit of 20', async () => {
    const rows = await getRecentRuns(5, { client: fakeClient({}) });
    assert.deepStrictEqual(rows, [{ id: '1' }]);
  });

  test('returns an empty array, never throws, when there are no rows', async () => {
    const client = { from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: null, error: null }) }) }) }) };
    const rows = await getRecentRuns(5, { client });
    assert.deepStrictEqual(rows, []);
  });
});
