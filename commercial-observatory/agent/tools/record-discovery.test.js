'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createRecordDiscoveryTool } = require('./record-discovery');

describe('record_discovery', () => {
  test('dry-run performs zero writes', async () => {
    let called = false;
    const appendDiscovery = async () => { called = true; return { success: true }; };
    const tool = createRecordDiscoveryTool({ appendDiscovery });
    const result = await tool.execute({ discoveredName: 'Acme Ltd', discoveryReason: 'linked as partner', investigationId: 'inv-1' }, { dryRun: true });
    assert.strictEqual(result.output.wouldPersist, true);
    assert.strictEqual(called, false);
  });

  test('live mode persists', async () => {
    const appendDiscovery = async () => ({ success: true, discovery: { id: 'disc-1' } });
    const tool = createRecordDiscoveryTool({ appendDiscovery });
    const result = await tool.execute({ discoveredName: 'Acme Ltd', discoveryReason: 'linked as partner', investigationId: 'inv-1' }, { dryRun: false });
    assert.strictEqual(result.output.discovery.id, 'disc-1');
  });
});
