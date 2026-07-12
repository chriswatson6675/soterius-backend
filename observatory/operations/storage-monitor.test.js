'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  linearForecast, computeGrowth, evaluateThresholds, captureSnapshot,
} = require('./storage-monitor');

const GiB = 1024 ** 3;

describe('linearForecast', () => {
  test('projects forward from a linear series', () => {
    const points = [{ day: 0, value: 100 }, { day: 1, value: 200 }, { day: 2, value: 300 }];
    const f = linearForecast(points, 10);
    assert.equal(Math.round(f.slopePerDay), 100);
    assert.equal(Math.round(f.projected), 300 + 1000);
  });
  test('daysUntil computes threshold crossing', () => {
    const f = linearForecast([{ day: 0, value: 0 }, { day: 1, value: 100 }], 30);
    assert.equal(f.daysUntil(1000), 9); // last value 100, slope 100 → (1000-100)/100
  });
  test('flat/declining series never crosses upward threshold', () => {
    const f = linearForecast([{ day: 0, value: 500 }, { day: 1, value: 500 }], 30);
    assert.equal(f.daysUntil(1000), null);
  });
  test('single point cannot forecast (slope 0)', () => {
    const f = linearForecast([{ day: 5, value: 42 }], 30);
    assert.equal(f.slopePerDay, 0);
    assert.equal(f.projected, 42);
  });
});

describe('computeGrowth', () => {
  test('per-day rates between two snapshots', () => {
    const prev = { captured_at: '2026-01-01T00:00:00Z', total_bytes: 1000, total_rows: 10 };
    const curr = { captured_at: '2026-01-03T00:00:00Z', total_bytes: 3000, total_rows: 50 };
    const g = computeGrowth(curr, prev);
    assert.equal(g.days, 2);
    assert.equal(g.deltaBytes, 2000);
    assert.equal(g.bytesPerDay, 1000);
    assert.equal(g.rowsPerDay, 20);
  });
  test('no previous snapshot → null growth', () => {
    const g = computeGrowth({ captured_at: '2026-01-01T00:00:00Z', total_bytes: 1 }, null);
    assert.equal(g.bytesPerDay, null);
  });
});

describe('evaluateThresholds', () => {
  const thresholds = {
    totalBytesWarn: 8 * GiB, totalBytesCritical: 12 * GiB,
    tableRowsWarn: 1_000_000, growthPerDayBytesWarn: 512 * 1024 ** 2, forecastHorizonDays: 90,
  };
  test('raises CRITICAL at the ceiling', () => {
    const w = evaluateThresholds(
      { total_bytes: 13 * GiB, tables: [] }, { bytesPerDay: 0 }, null, thresholds);
    assert.ok(w.some((x) => x.level === 'CRITICAL' && x.metric === 'total_bytes'));
  });
  test('raises WARN when a table is very large and when growth is steep', () => {
    const w = evaluateThresholds(
      { total_bytes: 9 * GiB, tables: [{ table: 'events', rows: 2_000_000 }] },
      { bytesPerDay: 600 * 1024 ** 2 }, null, thresholds);
    assert.ok(w.some((x) => x.metric === 'total_bytes' && x.level === 'WARN'));
    assert.ok(w.some((x) => x.metric === 'table_rows'));
    assert.ok(w.some((x) => x.metric === 'growth_bytes_per_day'));
  });
  test('forecast crossing within horizon raises a warning', () => {
    const forecast = { daysUntil: () => 30 };
    const w = evaluateThresholds({ total_bytes: 9 * GiB, tables: [] }, { bytesPerDay: 0 }, forecast, thresholds);
    assert.ok(w.some((x) => x.metric === 'forecast_days_until_critical'));
  });
  test('nothing raised when comfortably under thresholds', () => {
    const w = evaluateThresholds(
      { total_bytes: 1 * GiB, tables: [{ table: 'x', rows: 10 }] },
      { bytesPerDay: 1000 }, { daysUntil: () => null }, thresholds);
    assert.equal(w.length, 0);
  });
});

describe('captureSnapshot — orchestration with injected readers', () => {
  const groups = { observations: ['signal_facts_spf'], events: ['events'] };
  const rowCounts = { signal_facts_spf: 17000, events: 500 };
  const sizes = { signal_facts_spf: 5 * GiB, events: 100 * 1024 ** 2 };

  test('produces per-table + group + total metrics and persists a snapshot', async () => {
    const persisted = [];
    const report = await captureSnapshot(
      { groups },
      {
        client: {},
        getRowCount: async (t) => rowCounts[t] ?? 0,
        getTableSizes: async () => sizes,
        listPreviousSnapshots: async () => [],
        insertSnapshot: async (r) => persisted.push(r),
        now: () => '2026-07-12T00:00:00.000Z',
      },
    );
    assert.equal(report.total_rows, 17500);
    assert.equal(report.total_bytes, sizes.signal_facts_spf + sizes.events);
    assert.equal(report.groups.observations.rows, 17000);
    assert.equal(report.tables.find((t) => t.table === 'events').rows, 500);
    assert.equal(persisted.length, 1);
  });

  test('degrades gracefully when byte sizes are unavailable (rows-only telemetry)', async () => {
    const report = await captureSnapshot(
      { groups },
      {
        getRowCount: async (t) => rowCounts[t] ?? 0,
        getTableSizes: async () => null,       // rpc/migration not present
        listPreviousSnapshots: async () => [],
        insertSnapshot: async () => {},
        now: () => '2026-07-12T00:00:00.000Z',
      },
    );
    assert.equal(report.total_bytes, null);
    assert.equal(report.total_rows, 17500);
    assert.equal(report.forecast.metric, 'rows');
  });

  test('computes growth + forecast warnings from prior snapshots', async () => {
    // Growing history, current total (~5.1 GiB) above both → positive slope.
    const previous = [
      { captured_at: '2026-07-11T00:00:00.000Z', total_rows: 10000, total_bytes: 4 * GiB },
      { captured_at: '2026-07-10T00:00:00.000Z', total_rows: 5000, total_bytes: 3 * GiB },
    ];
    const report = await captureSnapshot(
      { groups, thresholds: { totalBytesCritical: 12 * GiB, forecastHorizonDays: 90 } },
      {
        getRowCount: async (t) => rowCounts[t] ?? 0,
        getTableSizes: async () => sizes,          // total ≈ 5.1 GiB now, but growth is steep
        listPreviousSnapshots: async () => previous,
        insertSnapshot: async () => {},
        now: () => '2026-07-12T00:00:00.000Z',
      },
    );
    assert.ok(report.growth.bytesPerDay != null);
    assert.ok(report.forecast.slopePerDay > 0);
    assert.ok(Array.isArray(report.warnings));
  });

  test('never proposes deletion — report has no destructive action field', async () => {
    const report = await captureSnapshot(
      { groups },
      { getRowCount: async () => 1, getTableSizes: async () => null, listPreviousSnapshots: async () => [], insertSnapshot: async () => {}, now: () => 'T' },
    );
    const serialized = JSON.stringify(report).toLowerCase();
    assert.ok(!serialized.includes('delete'));
    assert.ok(!serialized.includes('purge'));
    assert.ok(!serialized.includes('retention'));
  });
});
