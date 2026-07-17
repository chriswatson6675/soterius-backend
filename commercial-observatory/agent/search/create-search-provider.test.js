'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSearchProvider, SUPPORTED_PROVIDERS } = require('./create-search-provider');

function withEnv(vars, fn) {
  const original = {};
  for (const k of Object.keys(vars)) original[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

describe('createSearchProvider — explicit selection', () => {
  test('explicit brave selection', () => {
    const provider = createSearchProvider({ providerName: 'brave', brave: { apiKey: 'k' } });
    assert.strictEqual(provider.name, 'brave');
  });

  test('explicit legacy google selection', () => {
    const provider = createSearchProvider({ providerName: 'google_legacy', googleLegacy: { apiKey: 'k', searchEngineId: 'cx' } });
    assert.strictEqual(provider.name, 'google_legacy');
  });

  test('explicit disabled selection', async () => {
    const provider = createSearchProvider({ providerName: 'disabled' });
    assert.strictEqual(provider.name, 'disabled');
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'search_provider_disabled');
  });

  test('an unsupported provider name produces a clear structured failure, not a crash', async () => {
    const provider = createSearchProvider({ providerName: 'bing' });
    const result = await provider.search({ query: 'x' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'search_provider_unsupported');
  });
});

describe('createSearchProvider — automatic selection', () => {
  test('automatically selects brave when BRAVE_SEARCH_API_KEY is present and nothing is explicitly configured', () => {
    const provider = createSearchProvider({ braveApiKey: 'present-key' });
    assert.strictEqual(provider.name, 'brave');
  });

  test('google is never automatically selected, even with legacy Google credentials present and no Brave key', async () => {
    return withEnv({ GOOGLE_SEARCH_API_KEY: 'legacy-key', GOOGLE_SEARCH_CX: 'legacy-cx', BRAVE_SEARCH_API_KEY: undefined, COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER: undefined }, async () => {
      const provider = createSearchProvider({});
      const result = await provider.search({ query: 'x' });
      assert.notStrictEqual(provider.name, 'google_legacy');
      assert.strictEqual(result.errorType, 'search_provider_not_configured');
    });
  });

  test('missing configuration (no explicit provider, no Brave key) produces a clear, non-throwing failure', async () => {
    return withEnv({ COMMERCIAL_OBSERVATORY_SEARCH_PROVIDER: undefined, BRAVE_SEARCH_API_KEY: undefined }, async () => {
      const provider = createSearchProvider({});
      const result = await provider.search({ query: 'x' });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.errorType, 'search_provider_not_configured');
    });
  });
});

describe('createSearchProvider — supported provider list', () => {
  test('exposes exactly the three supported provider names', () => {
    assert.deepStrictEqual([...SUPPORTED_PROVIDERS].sort(), ['brave', 'disabled', 'google_legacy'].sort());
  });
});
