'use strict';

// benchmarkAggregation.test.js — T3.3 (ENG-013 WP3). Pure-function tests, no
// DB, matching the state-machine-style tests used for observation-session.js.

const { test } = require('node:test');
const assert = require('node:assert');

const { computeBenchmarkAggregates, aggregateGroup } = require('./benchmarkAggregation');

function scanRow({ sector, location, score, band, checks }) {
  return {
    overall_score: score,
    risk_band: band,
    prospects: { sector, location },
    scanner_results: [{ name: 'Security Headers', checks }],
  };
}

test('empty input yields a valid, zeroed aggregate (no special-casing needed by callers)', () => {
  const agg = computeBenchmarkAggregates([]);
  assert.deepStrictEqual(agg, {
    totalScans: 0,
    bySector: [],
    byLocation: [],
    bandDistribution: {},
    topFailedChecks: [],
    signalAdoption: [],
  });
});

test('rows with no linked prospect are skipped, not counted', () => {
  const scans = [{ overall_score: 80, risk_band: 'Good', prospects: null, scanner_results: [] }];
  const agg = computeBenchmarkAggregates(scans);
  assert.strictEqual(agg.totalScans, 1); // totalScans reflects row count, not aggregated count
  assert.deepStrictEqual(agg.bySector, []);
});

test('aggregates bySector and byLocation independently, with avg/min/max', () => {
  const scans = [
    scanRow({ sector: 'Legal', location: 'London', score: 80, band: 'Good', checks: [] }),
    scanRow({ sector: 'Legal', location: 'Manchester', score: 60, band: 'Moderate Risk', checks: [] }),
  ];
  const agg = computeBenchmarkAggregates(scans);

  assert.strictEqual(agg.bySector.length, 1);
  assert.strictEqual(agg.bySector[0].label, 'Legal');
  assert.strictEqual(agg.bySector[0].count, 2);
  assert.strictEqual(agg.bySector[0].avgScore, 70);
  assert.strictEqual(agg.bySector[0].minScore, 60);
  assert.strictEqual(agg.bySector[0].maxScore, 80);

  assert.strictEqual(agg.byLocation.length, 2);
  const londonEntry = agg.byLocation.find((e) => e.label === 'London');
  assert.strictEqual(londonEntry.count, 1);
});

test('bandDistribution counts by risk_band, defaulting to Unknown when absent', () => {
  const scans = [
    scanRow({ sector: 'Legal', location: 'London', score: 80, band: 'Good', checks: [] }),
    scanRow({ sector: 'Legal', location: 'London', score: 40, band: null, checks: [] }),
  ];
  const agg = computeBenchmarkAggregates(scans);
  assert.deepStrictEqual(agg.bandDistribution, { Good: 1, Unknown: 1 });
});

test('topFailedChecks counts only FAIL status, sorted descending, capped at 20', () => {
  const checks = [
    { name: 'CSP', status: 'FAIL' },
    { name: 'CSP', status: 'FAIL' },
    { name: 'HSTS', status: 'FAIL' },
    { name: 'X-Frame', status: 'PASS' },
  ];
  const scans = [scanRow({ sector: 'Legal', location: 'London', score: 50, band: 'Moderate Risk', checks })];
  const agg = computeBenchmarkAggregates(scans);

  assert.deepStrictEqual(agg.topFailedChecks, [
    { name: 'CSP', count: 2 },
    { name: 'HSTS', count: 1 },
  ]);
});

test('signalAdoption computes pass-percentage across PASS+WARNING+FAIL, sorted descending', () => {
  const checks = [
    { name: 'CSP', status: 'PASS' },
    { name: 'CSP', status: 'PASS' },
    { name: 'CSP', status: 'FAIL' },
    { name: 'HSTS', status: 'FAIL' },
  ];
  const scans = [scanRow({ sector: 'Legal', location: 'London', score: 50, band: 'Moderate Risk', checks })];
  const agg = computeBenchmarkAggregates(scans);

  const csp = agg.signalAdoption.find((s) => s.name === 'CSP');
  const hsts = agg.signalAdoption.find((s) => s.name === 'HSTS');
  assert.strictEqual(csp.passPercent, 67); // 2/3 rounded
  assert.strictEqual(hsts.passPercent, 0);
  assert.strictEqual(agg.signalAdoption[0].name, 'CSP'); // sorted descending by passPercent
});

test('aggregateGroup is independently exported and sorts by count descending', () => {
  const group = {
    A: { scores: [10] },
    B: { scores: [20, 30] },
  };
  const result = aggregateGroup(group);
  assert.strictEqual(result[0].label, 'B');
  assert.strictEqual(result[0].count, 2);
});
