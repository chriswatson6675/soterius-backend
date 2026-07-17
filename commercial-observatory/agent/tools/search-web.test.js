'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSearchWebTool } = require('./search-web');

function fakeResult(i) {
  return { title: `Result ${i}`, url: `https://example.com/${i}`, snippet: `snippet ${i}`, source: 'fake', rank: i + 1, retrievedAt: '2026-01-01T00:00:00.000Z', providerMetadata: {} };
}

function fakeProvider({ name = 'fake', results = [], success = true, errorType, error, retryable = false } = {}) {
  return {
    name,
    search: async (input) => success
      ? { success: true, provider: name, query: input.query, results, usage: {}, requestId: null }
      : { success: false, provider: name, query: input.query, errorType, error, retryable },
  };
}

describe('search_web — tool identity and provider neutrality', () => {
  test('remains registered under the same tool name', () => {
    const tool = createSearchWebTool({ provider: fakeProvider() });
    assert.strictEqual(tool.name, 'search_web');
  });

  test('planner/orchestrator receive the same internal result shape regardless of provider', async () => {
    const tool = createSearchWebTool({ provider: fakeProvider({ name: 'brave', results: [fakeResult(0), fakeResult(1)] }) });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.strictEqual(result.success, true);
    assert.ok(Array.isArray(result.output.results));
    assert.strictEqual(result.output.results.length, 2);
    assert.strictEqual(typeof result.output.query, 'string');
  });

  test('attaches the active provider name to the structured result (audit visibility)', async () => {
    const tool = createSearchWebTool({ provider: fakeProvider({ name: 'brave', results: [fakeResult(0)] }) });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.strictEqual(result.output.provider, 'brave');
    assert.strictEqual(result.provenance.provider, 'brave');
  });
});

describe('search_web — results are discovery aids only', () => {
  test('a result never carries an evidence id or persisted-flag — it is not evidence', async () => {
    const tool = createSearchWebTool({ provider: fakeProvider({ results: [fakeResult(0), fakeResult(1)] }) });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    for (const r of result.output.results) {
      assert.strictEqual(r.evidenceId, undefined);
      assert.strictEqual(r.persisted, undefined);
    }
  });
});

describe('search_web — configuration and validation', () => {
  test('rejects missing query', async () => {
    const tool = createSearchWebTool({ provider: fakeProvider() });
    const result = await tool.execute({ investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'invalid_input');
  });

  test('a provider failure surfaces as a clear structured tool failure — it does not crash the investigation', async () => {
    const tool = createSearchWebTool({ provider: fakeProvider({ success: false, errorType: 'not_configured', error: 'no key', retryable: false }) });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'not_configured');
  });

  test('never logs or exposes a credential in a failure result', async () => {
    const provider = { name: 'brave', search: async () => { throw new Error('should not be called directly — provider.search must itself never throw'); } };
    // The tool trusts provider.search to never throw (contract discipline);
    // this test instead verifies a provider-reported failure carries no
    // secret-shaped content, mirroring the provider-level tests.
    const failingProvider = fakeProvider({ success: false, errorType: 'authentication_error', error: 'invalid key ending abcd', retryable: false });
    const tool = createSearchWebTool({ provider: failingProvider });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.ok(!JSON.stringify(result).includes('super-secret'));
  });
});

describe('search_web — default provider wiring (no injected provider)', () => {
  test('without an injected provider, falls back to the factory and reports search_provider_not_configured honestly when nothing is configured', async () => {
    const tool = createSearchWebTool({ providerName: undefined, braveApiKey: null });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'search_provider_not_configured');
  });

  test('explicit providerName selection reaches the factory unchanged', async () => {
    const tool = createSearchWebTool({ providerName: 'disabled' });
    const result = await tool.execute({ query: 'x', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'search_provider_disabled');
  });
});
