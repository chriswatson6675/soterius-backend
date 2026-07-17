'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRecordClaimTool } = require('./record-claim');

function fakeBundle(evidenceIds) {
  return async () => ({ success: true, bundle: { evidence: evidenceIds.map((id) => ({ id })) } });
}

describe('record_claim', () => {
  test('rejects a claim with no cited evidence', async () => {
    const tool = createRecordClaimTool({ getInvestigationBundle: fakeBundle(['ev-1']) });
    const result = await tool.execute({ claimType: 'identity', field: 'legalName', value: 'X', confidence: 'high', investigationId: 'inv-1' }, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'invalid_input');
  });

  test('rejects a claim citing evidence from another investigation', async () => {
    const tool = createRecordClaimTool({ getInvestigationBundle: fakeBundle(['ev-1']) });
    const result = await tool.execute({ claimType: 'identity', field: 'legalName', value: 'X', confidence: 'high', evidenceIds: ['ev-from-another-investigation'], investigationId: 'inv-1' }, {});
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.errorType, 'evidence_not_in_investigation');
  });

  test('accepts a claim citing evidence that belongs to this investigation', async () => {
    const appendClaim = async () => ({ success: true, claim: { id: 'claim-1' } });
    const tool = createRecordClaimTool({ getInvestigationBundle: fakeBundle(['ev-1']), appendClaim });
    const result = await tool.execute({ claimType: 'identity', field: 'legalName', value: 'X', confidence: 'high', evidenceIds: ['ev-1'], investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.success, true);
  });

  test('dry-run performs zero writes', async () => {
    let called = false;
    const appendClaim = async () => { called = true; return { success: true }; };
    const tool = createRecordClaimTool({ getInvestigationBundle: fakeBundle(['ev-1']), appendClaim });
    const result = await tool.execute({ claimType: 'identity', field: 'legalName', value: 'X', confidence: 'high', evidenceIds: ['ev-1'], investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.output.wouldPersist, true);
    assert.strictEqual(called, false);
  });
});
