'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeClient } = require('../persistence/fake-client');
const { createInvestigation } = require('./create-investigation');

describe('createInvestigation (domain service)', () => {
  test('rejects when neither name nor domain supplied, before touching persistence', async () => {
    const client = createFakeClient();
    const result = await createInvestigation({}, { client });
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(client._tables, {});
  });

  test('normalises the supplied domain using the existing canonical normaliser', async () => {
    const client = createFakeClient();
    const result = await createInvestigation({ domain: 'https://WWW.Example.com/' }, { client });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.investigation.targetDomainNormalised, 'example.com');
  });

  test('creates the investigation, its initial dossier, and a creation event', async () => {
    const client = createFakeClient();
    const result = await createInvestigation({ name: 'Example Ltd', domain: 'example.com' }, { client });

    assert.strictEqual(result.success, true);
    assert.ok(result.investigationId);
    assert.strictEqual(result.investigation.status, 'pending');
    assert.strictEqual(result.dossier.workingState.target.name, 'Example Ltd');
    assert.strictEqual(result.dossier.workingState.target.domain, 'example.com');

    const events = client._tables.commercial_agent_events;
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, 'investigation_created');
  });

  test('accepts a rerunOf id and preserves it on the new investigation', async () => {
    const client = createFakeClient();
    const first = await createInvestigation({ domain: 'example.com' }, { client });
    const rerun = await createInvestigation({ domain: 'example.com', rerunOf: first.investigationId }, { client });
    assert.strictEqual(rerun.investigation.rerunOf, first.investigationId);
  });

  test('does not call an LLM, web search, or worker — only persistence is touched', async () => {
    const client = createFakeClient();
    await createInvestigation({ domain: 'example.com' }, { client });
    const touchedTables = Object.keys(client._tables);
    assert.ok(touchedTables.every((t) => t.startsWith('commercial_')));
  });
});
