'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFcaLookupTool } = require('./fca-lookup');

const CONFIG = { email: 'e@example.com', apiKey: 'k', baseUrl: 'https://register.fca.org.uk/services/V0.1' };

describe('fca_lookup', () => {
  test('an exact name match is reported with high confidence', async () => {
    const getJson = async () => ({ errorType: 'NONE', body: { Data: [{ FRN: '123456', 'Organisation Name': 'Example Compliance Ltd', Status: 'Authorised' }] } });
    const tool = createFcaLookupTool({ loadConfig: () => CONFIG, getJson });
    const result = await tool.execute({ name: 'Example Compliance Ltd', investigationId: 'inv-1' });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.matched, true);
    assert.strictEqual(result.output.matchConfidence, 'high');
    assert.strictEqual(result.output.firm.frn, '123456');
  });

  test('distinguishes no result from a tool failure', async () => {
    const noResultTool = createFcaLookupTool({ loadConfig: () => CONFIG, getJson: async () => ({ errorType: 'NONE', body: { Data: [] } }) });
    const noResult = await noResultTool.execute({ name: 'Not A Firm', investigationId: 'inv-1' });
    assert.strictEqual(noResult.success, true);
    assert.strictEqual(noResult.output.matched, false);
    assert.strictEqual(noResult.output.matchBasis, 'no_result');

    const failingTool = createFcaLookupTool({ loadConfig: () => CONFIG, getJson: async () => ({ errorType: 'HTTP_ERROR', errorMessage: 'server error' }) });
    const failure = await failingTool.execute({ name: 'X', investigationId: 'inv-1' });
    assert.strictEqual(failure.success, false);
  });

  test('reports not_configured honestly when FCA credentials are absent', async () => {
    const tool = createFcaLookupTool({ loadConfig: () => ({ email: null, apiKey: null, baseUrl: CONFIG.baseUrl }) });
    const result = await tool.execute({ name: 'X', investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'not_configured');
  });

  test('never exposes the API key in a result', async () => {
    const secretConfig = { ...CONFIG, apiKey: 'super-secret-fca-key-xyz' };
    const tool = createFcaLookupTool({ loadConfig: () => secretConfig, getJson: async () => ({ errorType: 'CONNECTION_ERROR', errorMessage: 'refused' }) });
    const result = await tool.execute({ name: 'X', investigationId: 'inv-1' });
    assert.ok(!JSON.stringify(result).includes(secretConfig.apiKey));
  });
});
