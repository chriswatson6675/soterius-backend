'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createInspectTargetWebsiteTool } = require('./inspect-target-website');

describe('inspect_target_website', () => {
  test('refuses to run in dry-run mode, explaining why, without calling the underlying pipeline', async () => {
    let called = false;
    const researchWebsite = async () => { called = true; return { success: true }; };
    const tool = createInspectTargetWebsiteTool({ researchWebsite });
    const result = await tool.execute({ investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.skipped, true);
    assert.strictEqual(called, false);
  });

  test('runs the underlying pipeline when not in dry-run', async () => {
    const researchWebsite = async (id) => ({ success: true, investigationId: id, status: 'completed', pagesVisited: [{}, {}] });
    const tool = createInspectTargetWebsiteTool({ researchWebsite });
    const result = await tool.execute({ investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.status, 'completed');
  });

  test('propagates a failed research run as a structured failure', async () => {
    const researchWebsite = async () => ({ success: false, error: 'homepage unreachable' });
    const tool = createInspectTargetWebsiteTool({ researchWebsite });
    const result = await tool.execute({ investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.success, false);
  });
});
