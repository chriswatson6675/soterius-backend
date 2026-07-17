'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFinishInvestigationTool } = require('./finish-investigation');

describe('finish_investigation', () => {
  test('dry-run performs zero writes and shows the proposed draft', async () => {
    let called = false;
    const createDraft = async () => { called = true; return { success: true }; };
    const tool = createFinishInvestigationTool({ createDraft });
    const result = await tool.execute({ draftContent: { target: { name: 'Compliance Office' } }, investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.output.wouldPersist, true);
    assert.deepStrictEqual(result.output.preview, { target: { name: 'Compliance Office' } });
    assert.strictEqual(called, false);
  });

  test('live mode creates a pending draft (never approved)', async () => {
    const createDraft = async () => ({ success: true, draft: { id: 'draft-1', reviewState: 'pending' } });
    const tool = createFinishInvestigationTool({ createDraft });
    const result = await tool.execute({ draftContent: {}, investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.output.draft.reviewState, 'pending');
  });
});
