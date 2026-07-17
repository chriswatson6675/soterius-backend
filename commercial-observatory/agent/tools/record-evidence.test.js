'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRecordEvidenceTool } = require('./record-evidence');

describe('record_evidence', () => {
  test('dry-run performs zero writes and returns a preview', async () => {
    let called = false;
    const appendEvidence = async () => { called = true; return { success: true }; };
    const tool = createRecordEvidenceTool({ appendEvidence });
    const result = await tool.execute({ sourceUrl: 'https://example.com', retrievedAt: '2026-07-15T00:00:00.000Z', evidenceClass: 'public', investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.wouldPersist, true);
    assert.strictEqual(called, false);
  });

  test('live mode persists via the injected appendEvidence', async () => {
    const appendEvidence = async () => ({ success: true, evidence: { id: 'ev-1' } });
    const tool = createRecordEvidenceTool({ appendEvidence });
    const result = await tool.execute({ sourceUrl: 'https://example.com', retrievedAt: '2026-07-15T00:00:00.000Z', evidenceClass: 'public', investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.output.wouldPersist, false);
    assert.strictEqual(result.output.evidence.id, 'ev-1');
  });

  test('rejects invalid input', async () => {
    const tool = createRecordEvidenceTool({});
    const result = await tool.execute({ investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.success, false);
  });
});
