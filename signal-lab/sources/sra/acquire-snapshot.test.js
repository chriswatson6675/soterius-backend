'use strict';

// acquire-snapshot.test.js — Observe acquisition tests.
//
// Covers successful single-document acquisition, transient retry, segmented
// (cursor) acquisition, persistent transport failure (structured, no throw),
// byte-faithful raw return, production-timestamp extraction, and programmer-error
// guards. No network, no preservation.

const { test } = require('node:test');
const assert = require('node:assert');

const { acquireSnapshot } = require('./acquire-snapshot');
const { defineSource } = require('./snapshot-source');
const { buildUrl } = require('./sra-client');

function bodyBuf(s) { return Buffer.from(typeof s === 'string' ? s : JSON.stringify(s), 'utf8'); }
function ok(body, status = 200) { return { statusCode: status, headers: {}, bodyBuffer: bodyBuf(body) }; }

// Sequence transport: returns responses[i] per call, repeating the last.
function seqFetch(responses, calls = []) {
  let i = 0;
  return async (url, o) => { calls.push({ url, headers: o.headers }); const r = responses[Math.min(i, responses.length - 1)]; i++; return r; };
}
// URL-keyed transport for cursor mode.
function keyedFetch(map, calls = []) {
  return async (url, o) => { calls.push({ url, headers: o.headers }); return map[url] ?? { error: { code: 'ENOTFOUND' } }; };
}

const CONFIG = { baseUrl: 'https://x', subscriptionKey: 'KEY' };
const noSleep = { _sleep: async () => {} };

test('single-mode: acquires one segment, returns the raw body EXACTLY, reads production timestamp', async () => {
  const RAW = '{"productionDate":"2026-06-28T23:00:00Z","firms":[{"SRA number":"123456"}]}';
  const r = await acquireSnapshot({ config: CONFIG, source: defineSource({ productionTimestampPath: ['productionDate'] }), _fetch: seqFetch([ok(RAW)]) });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.segmentCount, 1);
  assert.strictEqual(r.segments[0].name, 'snapshot.json');
  assert.strictEqual(r.segments[0].body, RAW, 'raw body returned byte-for-byte');
  assert.strictEqual(r.productionTimestamp, '2026-06-28T23:00:00Z');
  assert.strictEqual(r.error, null);
});

test('reuses retry: a transient 503 then 200 succeeds, logging both attempts', async () => {
  const calls = [];
  const RAW = '{"productionDate":"2026-06-28","firms":[]}';
  const r = await acquireSnapshot({
    config: CONFIG,
    _fetch: seqFetch([ok('try later', 503), ok(RAW)], calls),
    retry: { maxAttempts: 3, baseDelayMs: 1 },
    _retryHelpers: noSleep,
  });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.segments[0].body, RAW);
  assert.strictEqual(r.segments[0].attempts.length, 2, 'one retry after the transient failure');
  assert.strictEqual(r.segments[0].attempts[0].outcome, 'transient');
  assert.strictEqual(r.segments[0].attempts[1].outcome, 'success');
  assert.strictEqual(calls.length, 2);
});

test('cursor-mode: follows the next link across segments, preserving each body verbatim', async () => {
  const src = defineSource({ datasetPath: '/firms', productionTimestampPath: ['productionDate'], segmentation: { mode: 'cursor', nextPath: ['next'] } });
  const url1 = buildUrl(CONFIG.baseUrl, '/firms');
  const url2 = 'https://x/firms?page=2';
  const PAGE1 = JSON.stringify({ productionDate: '2026-06-28', next: url2, firms: [{ id: 1 }] });
  const PAGE2 = JSON.stringify({ next: null, firms: [{ id: 2 }] });
  const calls = [];
  const r = await acquireSnapshot({ config: CONFIG, source: src, _fetch: keyedFetch({ [url1]: ok(PAGE1), [url2]: ok(PAGE2) }, calls) });

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.segmentCount, 2);
  assert.deepStrictEqual(r.segments.map((s) => s.name), ['segment-0001.json', 'segment-0002.json']);
  assert.strictEqual(r.segments[0].body, PAGE1);
  assert.strictEqual(r.segments[1].body, PAGE2);
  assert.strictEqual(r.productionTimestamp, '2026-06-28', 'read from the first segment');
  assert.deepStrictEqual(calls.map((c) => c.url), [url1, url2]);
});

test('persistent transport failure → ok:false with structured error, no throw', async () => {
  const r = await acquireSnapshot({
    config: CONFIG,
    _fetch: seqFetch([ok('boom', 500)]),
    retry: { maxAttempts: 2, baseDelayMs: 1 },
    _retryHelpers: noSleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.errorType, 'HTTP_ERROR');
  assert.strictEqual(r.error.httpStatus, 500);
  assert.strictEqual(r.segmentCount, 0);
});

test('connection failure is surfaced (not thrown)', async () => {
  const r = await acquireSnapshot({
    config: CONFIG,
    _fetch: async () => ({ error: { code: 'ECONNREFUSED' } }),
    retry: { maxAttempts: 1 },
    _retryHelpers: noSleep,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.errorType, 'CONNECTION_ERROR');
});

test('production timestamp is null when the body is unparseable or the locator misses', async () => {
  const r1 = await acquireSnapshot({ config: CONFIG, _fetch: seqFetch([ok('<<not json>>')]) });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.segments[0].body, '<<not json>>', 'raw still returned untouched');
  assert.strictEqual(r1.productionTimestamp, null);

  const r2 = await acquireSnapshot({ config: CONFIG, _fetch: seqFetch([ok('{"firms":[]}')]) });
  assert.strictEqual(r2.productionTimestamp, null);
});

test('throws only on programmer error (missing config.baseUrl)', async () => {
  await assert.rejects(() => acquireSnapshot({ config: {} }), /config\.baseUrl/);
});
