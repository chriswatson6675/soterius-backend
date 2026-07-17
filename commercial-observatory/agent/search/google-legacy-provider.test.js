'use strict';

// Regression coverage carried over from the original (pre-Brave)
// search-web.test.js — preserved here since the Google-specific behaviour
// they exercise now lives in this isolated legacy provider.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleLegacyProvider, PROVIDER_NAME, PROVIDER_METADATA } = require('./google-legacy-provider');

function fakeItems(n) {
  return Array.from({ length: n }, (_, i) => ({ title: `Result ${i}`, link: `https://example.com/${i}`, snippet: `snippet ${i}` }));
}

describe('google_legacy provider — deprecation marker', () => {
  test('is clearly marked deprecated in structured metadata', () => {
    assert.strictEqual(PROVIDER_NAME, 'google_legacy');
    assert.strictEqual(PROVIDER_METADATA.deprecated, true);
  });
});

describe('google_legacy provider — bounded results', () => {
  test('caps results at the requested maxResults', async () => {
    const httpGet = async () => ({ data: { items: fakeItems(10) } });
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'compliance office', maxResults: 3 });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.results.length, 3);
  });

  test('never exceeds the hard cap even if maxResults is requested higher', async () => {
    const httpGet = async () => ({ data: { items: fakeItems(20) } });
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'x', maxResults: 999 });
    assert.ok(result.results.length <= 10);
  });
});

describe('google_legacy provider — retry behaviour', () => {
  test('retries once on a transient (5xx-shaped) failure, succeeding on the second attempt', async () => {
    let calls = 0;
    const httpGet = async () => {
      calls += 1;
      if (calls === 1) { const e = new Error('server error'); e.response = { status: 503 }; throw e; }
      return { data: { items: fakeItems(2) } };
    };
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 2);
  });

  test('does not retry a non-transient error', async () => {
    let calls = 0;
    const httpGet = async () => { calls += 1; const e = new Error('bad request'); e.response = { status: 400 }; throw e; };
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(calls, 1);
  });

  test('the known real-world 403 is a normal structured failure, not a crash', async () => {
    const httpGet = async () => {
      const e = new Error('Request failed with status code 403');
      e.response = { status: 403, data: { error: { message: 'This project does not have the access to Custom Search JSON API.' } } };
      throw e;
    };
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'authentication_error');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.provider, 'google_legacy');
  });
});

describe('google_legacy provider — results are discovery aids only', () => {
  test('a result never carries an evidence id or persisted-flag — it is not evidence', async () => {
    const httpGet = async () => ({ data: { items: fakeItems(2) } });
    const provider = createGoogleLegacyProvider({ apiKey: 'k', searchEngineId: 'cx', httpGet });
    const result = await provider.search({ query: 'x' });
    for (const r of result.results) {
      assert.strictEqual(r.evidenceId, undefined);
      assert.strictEqual(r.persisted, undefined);
    }
  });
});

describe('google_legacy provider — configuration and validation', () => {
  test('reports not_configured honestly when no API key/engine id is available, never throws', async () => {
    const provider = createGoogleLegacyProvider({ apiKey: null, searchEngineId: null });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'not_configured');
  });

  test('never logs or exposes the API key in a failure result', async () => {
    const provider = createGoogleLegacyProvider({ apiKey: 'super-secret-key', searchEngineId: 'cx', httpGet: async () => { throw new Error('boom'); } });
    const result = await provider.search({ query: 'x' });
    assert.ok(!JSON.stringify(result).includes('super-secret-key'));
  });
});
