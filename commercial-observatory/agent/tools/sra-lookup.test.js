'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createSraLookupTool } = require('./sra-lookup');

describe('sra_lookup', () => {
  test('an exact name match is reported with high confidence', async () => {
    const searchByName = async () => ({ ok: true, results: [{ sraNumber: '123', name: 'Example Solicitors LLP' }], asOf: '2026-07-01' });
    const tool = createSraLookupTool({ searchByName });
    const result = await tool.execute({ name: 'Example Solicitors LLP', investigationId: 'inv-1' });
    assert.strictEqual(result.output.matched, true);
    assert.strictEqual(result.output.matchConfidence, 'high');
  });

  test('distinguishes no result from a tool failure', async () => {
    const noResultTool = createSraLookupTool({ searchByName: async () => ({ ok: true, results: [], asOf: '2026-07-01' }) });
    const noResult = await noResultTool.execute({ name: 'Not A Firm', investigationId: 'inv-1' });
    assert.strictEqual(noResult.success, true);
    assert.strictEqual(noResult.output.matched, false);

    const failingTool = createSraLookupTool({ searchByName: async () => ({ ok: false, error: 'snapshot unavailable' }) });
    const failure = await failingTool.execute({ name: 'X', investigationId: 'inv-1' });
    assert.strictEqual(failure.success, false);
  });

  test('looks up directly by SRA number when supplied', async () => {
    const findBySraNumber = async () => ({ ok: true, firm: { sraNumber: '123', name: 'Example Solicitors LLP' }, asOf: '2026-07-01' });
    const tool = createSraLookupTool({ findBySraNumber });
    const result = await tool.execute({ sraNumber: '123', investigationId: 'inv-1' });
    assert.strictEqual(result.output.matchBasis, 'sra_number_lookup');
  });

  test('rejects input with neither name nor sraNumber', async () => {
    const tool = createSraLookupTool({});
    const result = await tool.execute({ investigationId: 'inv-1' });
    assert.strictEqual(result.success, false);
  });
});
