'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { collectDnsSignal, DNS_OBSERVATION_TYPES } = require('./dns-signal-collection');

function baseDeps(overrides = {}) {
  return {
    adapters: { spf: { tableName: 'signal_facts_spf' }, caa: { tableName: 'signal_facts_caa' } },
    runCollection: async () => ({
      run: { id: 'run-1' },
      observations: [{ ok: true }],
    }),
    readPersistedFacts: async () => ({
      data: { id: 'facts-1', domain: 'example.com', collected_at: '2026-07-16T00:00:00.000Z', collector_version: 'spf-collector@1.0.0', spf_present: true },
      error: null,
    }),
    persistQuality: async () => ({ ok: true, persisted: true, result: { score: 90 }, row: { id: 'quality-1' } }),
    collectCaaAncestors: async () => new Map(),
    client: {},
    ...overrides,
  };
}

describe('collectDnsSignal — supported types', () => {
  test('rejects an observation type outside the DNS-based five', async () => {
    await assert.rejects(() => collectDnsSignal('example.com', 'mtasts', baseDeps()), /not a supported DNS observation type/);
  });

  test('DNS_OBSERVATION_TYPES is exactly the five DNS-based signals — no MTA-STS/security headers/security.txt/TLS/certificate', () => {
    assert.deepStrictEqual(DNS_OBSERVATION_TYPES, ['spf', 'dkim', 'dmarc', 'dnssec', 'caa']);
  });
});

describe('collectDnsSignal — success path', () => {
  test('observed + scored: returns factsRow and qualityRow', async () => {
    const result = await collectDnsSignal('example.com', 'spf', baseDeps());
    assert.equal(result.observed, true);
    assert.equal(result.scored, true);
    assert.equal(result.factsRow.id, 'facts-1');
    assert.equal(result.qualityRow.id, 'quality-1');
    assert.equal(result.error, null);
  });

  test('CAA additionally invokes the ancestor-population lookup', async () => {
    let called = false;
    const deps = baseDeps({ collectCaaAncestors: async () => { called = true; return new Map(); } });
    await collectDnsSignal('example.com', 'caa', deps);
    assert.equal(called, true);
  });

  test('non-CAA signals never invoke the ancestor-population lookup', async () => {
    let called = false;
    const deps = baseDeps({ collectCaaAncestors: async () => { called = true; return new Map(); } });
    await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(called, false);
  });

  test('observed but not scored (quality persistence declined) is not treated as a failure', async () => {
    const deps = baseDeps({ persistQuality: async () => ({ ok: true, persisted: false, result: { reason: 'below minimum evidence' } }) });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.observed, true);
    assert.equal(result.scored, false);
    assert.equal(result.error, null);
    assert.equal(result.reason, 'below minimum evidence');
  });
});

describe('collectDnsSignal — failure paths (Unknown != Absent: the collector\'s own classification is never overridden)', () => {
  test('a collection-session exception is reported as a failure with its own message', async () => {
    const deps = baseDeps({ runCollection: async () => { throw new Error('DNS resolver timeout'); } });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.observed, false);
    assert.equal(result.error, 'DNS resolver timeout');
  });

  test('an observation-level error from the Collection Session is preserved verbatim, not generalised', async () => {
    const deps = baseDeps({ runCollection: async () => ({ run: { id: 'run-1' }, observations: [{ error: 'NXDOMAIN' }] }) });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.observed, false);
    assert.equal(result.error, 'NXDOMAIN');
  });

  test('a distinct failure reason (e.g. timeout) is preserved distinctly from NXDOMAIN, not collapsed to one generic reason', async () => {
    const deps = baseDeps({ runCollection: async () => ({ run: { id: 'run-1' }, observations: [{ error: 'ETIMEDOUT' }] }) });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.error, 'ETIMEDOUT');
  });

  test('a read-back failure after successful collection is reported as observed=true, scored=false', async () => {
    const deps = baseDeps({ readPersistedFacts: async () => ({ data: null, error: { message: 'row not found' } }) });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.observed, true);
    assert.equal(result.scored, false);
    assert.equal(result.factsRow, null);
  });

  test('a quality-scoring exception is reported as observed=true, scored=false, with its own error', async () => {
    const deps = baseDeps({ persistQuality: async () => ({ ok: false, error: 'quality model threw' }) });
    const result = await collectDnsSignal('example.com', 'spf', deps);
    assert.equal(result.observed, true);
    assert.equal(result.scored, false);
    assert.equal(result.error, 'quality model threw');
  });
});
