'use strict';

// benchmarks.test.js — T3.3 (ENG-013 WP3). Confirms the route is a thin
// wrapper delegating to the shared computeBenchmarkAggregates() — the
// aggregation logic itself is covered by benchmarkAggregation.test.js.

const { test } = require('node:test');
const assert = require('node:assert');

const { createGetBenchmarks } = require('./benchmarks');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('no cohort filter — aggregates every scan, response has no byLocation/success key (preserves original shape)', async () => {
  const raw = [
    { overall_score: 80, risk_band: 'Good', prospects: { sector: 'Legal', location: 'London', source: 'fca' }, scanner_results: [] },
  ];
  const getBenchmarks = createGetBenchmarks(async () => raw);
  const req = { query: {} };
  const res = fakeRes();
  const next = () => assert.fail('next() should not be called');

  await getBenchmarks(req, res, next);

  assert.strictEqual(res.body.cohort, 'All');
  assert.strictEqual(res.body.totalScans, 1);
  assert.ok(Array.isArray(res.body.bySector));
  assert.ok(Array.isArray(res.body.signalAdoption));
  assert.strictEqual(res.body.byLocation, undefined); // benchmarks.js never returned byLocation
  assert.strictEqual(res.body.success, undefined); // benchmarks.js never wrapped in { success }
});

test('cohort filter narrows to matching prospects.source/cohort only', async () => {
  const raw = [
    { overall_score: 80, risk_band: 'Good', prospects: { sector: 'Legal', location: 'London', source: 'fca' }, scanner_results: [] },
    { overall_score: 40, risk_band: 'High Risk', prospects: { sector: 'Legal', location: 'London', source: 'manual' }, scanner_results: [] },
  ];
  const getBenchmarks = createGetBenchmarks(async () => raw);
  const req = { query: { cohort: 'fca' } };
  const res = fakeRes();
  const next = () => assert.fail('next() should not be called');

  await getBenchmarks(req, res, next);

  assert.strictEqual(res.body.cohort, 'fca');
  assert.strictEqual(res.body.totalScans, 1);
});

test('an empty result set still returns a well-formed, zeroed response (no special-case branch needed)', async () => {
  const getBenchmarks = createGetBenchmarks(async () => []);
  const req = { query: {} };
  const res = fakeRes();
  const next = () => assert.fail('next() should not be called');

  await getBenchmarks(req, res, next);

  assert.strictEqual(res.body.totalScans, 0);
  assert.deepStrictEqual(res.body.bySector, []);
  assert.deepStrictEqual(res.body.bandDistribution, {});
});

test('a data-layer error is forwarded to next(), not swallowed', async () => {
  const getBenchmarks = createGetBenchmarks(async () => { throw new Error('db down'); });
  const req = { query: {} };
  const res = fakeRes();
  let caught = null;
  const next = (err) => { caught = err; };

  await getBenchmarks(req, res, next);

  assert.ok(caught instanceof Error);
  assert.strictEqual(caught.message, 'db down');
});
