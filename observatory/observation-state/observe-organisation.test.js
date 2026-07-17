'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { observeOneSignal, observeOrganisationDnsSignals } = require('./observe-organisation');

// Generic in-memory fake Supabase client — supports observation_states
// (insert/select/update, as store.js uses it) and arbitrary evidence tables
// (select().eq().maybeSingle(), as fetchByRef uses them).
function fakeClient(seedTables = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seedTables)) tables[name] = rows.map((r) => ({ ...r }));
  let nextId = 1;
  return {
    _tables: tables,
    from(table) {
      if (!tables[table]) tables[table] = [];
      const rows = tables[table];
      return {
        insert(row) {
          return {
            select() {
              return {
                single() {
                  const stored = { id: row.id || `gen-${nextId++}`, created_at: '2026-07-16T00:00:00.000Z', updated_at: '2026-07-16T00:00:00.000Z', ...row };
                  rows.push(stored);
                  return Promise.resolve({ data: stored, error: null });
                },
              };
            },
          };
        },
        select() {
          let filtered = rows;
          const builder = {
            eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
            maybeSingle() { return Promise.resolve({ data: filtered[0] || null, error: null }); },
          };
          return builder;
        },
        update(patch) {
          let filtered = rows;
          const builder = {
            eq(col, val) { filtered = filtered.filter((r) => r[col] === val); return builder; },
            select() {
              return {
                maybeSingle() {
                  if (!filtered.length) return Promise.resolve({ data: null, error: null });
                  Object.assign(filtered[0], patch);
                  return Promise.resolve({ data: filtered[0], error: null });
                },
              };
            },
          };
          return builder;
        },
      };
    },
  };
}

const ADAPTERS = { spf: { tableName: 'signal_facts_spf' }, dkim: { tableName: 'signal_facts_dkim' } };

function successResult(overrides = {}) {
  return {
    observed: true, scored: true, error: null,
    factsRow: { id: 'facts-1', domain: 'example.com', collected_at: '2026-07-16T00:00:00.000Z', collector_version: 'spf-collector@1.0.0', spf_present: true, spf_record: 'v=spf1 -all' },
    qualityRow: { id: 'quality-1' },
    ...overrides,
  };
}

describe('observeOneSignal — successful first observation', () => {
  test('creates an Observation State, sets evidence_ref/provenance_ref/collector_version, status observed, material_change null', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => successResult(),
      now: () => '2026-07-16T00:00:00.000Z',
    });

    assert.equal(result.ok, true);
    assert.equal(result.observationState.status, 'observed');
    assert.equal(result.observationState.evidenceRef, 'signal_facts_spf:facts-1');
    assert.equal(result.observationState.provenanceRef, 'signal_quality_spf:quality-1');
    assert.equal(result.observationState.collectorVersion, 'spf-collector@1.0.0');
    assert.equal(result.observationState.materialChange, null);
    assert.equal(result.observationState.lastObservedAt, '2026-07-16T00:00:00.000Z');
    assert.equal(result.observationState.attemptCount, 0);
  });

  test('a childError from collection is surfaced on the result without affecting the Observation State itself', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'dkim', {
      client, adapters: { dkim: { tableName: 'signal_facts_dkim' } },
      collectDnsSignal: async () => successResult({ childError: 'insert failed: null value in column "selector"' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.childError, 'insert failed: null value in column "selector"');
    assert.equal(result.observationState.status, 'observed'); // primary Evidence + score are genuinely complete
  });

  test('no childError surfaces as null, not undefined', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => successResult(),
    });
    assert.equal(result.childError, null);
  });

  test('sets next_due_at per the assigned cadence policy (spf = daily)', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => successResult(),
    });
    assert.equal(result.observationState.nextDueAt, '2026-07-16T08:30:00.000Z'); // next 09:30 Europe/London (BST) after the observed instant
  });

  test('DNSSEC/CAA get a weekly next_due_at', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'dnssec', {
      client, adapters: { dnssec: { tableName: 'signal_facts_dnssec' } },
      collectDnsSignal: async () => successResult({
        factsRow: { id: 'facts-2', domain: 'example.com', collected_at: '2026-07-16T00:00:00.000Z', collector_version: 'dnssec-collector@1.0.0' },
        qualityRow: { id: 'quality-2' },
      }),
    });
    assert.equal(result.observationState.nextDueAt, '2026-07-23T08:30:00.000Z'); // 7 days later, anchored to 09:30 Europe/London (BST)
  });
});

// A real signal_facts_* row only exists in the real database once the real
// Collection Session inserts it — collectDnsSignal is mocked wholesale in
// these tests, so the facts rows it "returns" are never actually written
// anywhere fetchByRef's default (a real client query) could find them.
// Providing an explicit fetchByRef backed by a plain in-memory map is the
// correct way to exercise the previous-evidence lookup without faking an
// entire signal_facts_spf table.
function evidenceRefLookup() {
  const byRef = new Map();
  return {
    record(tableName, row) { byRef.set(`${tableName}:${row.id}`, row); },
    fetchByRef: async (ref) => byRef.get(ref) || null,
  };
}

describe('observeOneSignal — re-observation, no material change', () => {
  test('a second identical observation reports materialChange "false" and does not lose the evidence pointer', async () => {
    const client = fakeClient();
    const lookup = evidenceRefLookup();
    const firstFacts = successResult().factsRow;
    lookup.record('signal_facts_spf', firstFacts);

    const first = await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, fetchByRef: lookup.fetchByRef, collectDnsSignal: async () => successResult() });
    assert.equal(first.observationState.materialChange, null);

    const second = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS, fetchByRef: lookup.fetchByRef,
      collectDnsSignal: async () => successResult({
        factsRow: { id: 'facts-1', domain: 'example.com', collected_at: '2026-07-17T00:00:00.000Z', collector_version: 'spf-collector@1.0.0', spf_present: true, spf_record: 'v=spf1 -all' },
        qualityRow: { id: 'quality-1' },
      }),
    });
    assert.equal(second.observationState.materialChange, 'false');
  });
});

describe('observeOneSignal — re-observation, material change', () => {
  test('a genuinely different Evidence result reports materialChange "true"', async () => {
    const client = fakeClient();
    const lookup = evidenceRefLookup();
    lookup.record('signal_facts_spf', successResult().factsRow);

    await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, fetchByRef: lookup.fetchByRef, collectDnsSignal: async () => successResult() });

    const second = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS, fetchByRef: lookup.fetchByRef,
      collectDnsSignal: async () => successResult({
        factsRow: { id: 'facts-3', domain: 'example.com', collected_at: '2026-07-17T00:00:00.000Z', collector_version: 'spf-collector@1.0.0', spf_present: false, spf_record: null },
        qualityRow: { id: 'quality-3' },
      }),
    });
    assert.equal(second.observationState.materialChange, 'true');
    assert.equal(second.observationState.evidenceRef, 'signal_facts_spf:facts-3');
  });
});

describe('observeOneSignal — failure handling (Unknown != Absent)', () => {
  test('a failed collection updates attempt_count/last_failure_at/last_failure_reason/status, never the evidence pointer', async () => {
    const client = fakeClient();
    // First: a successful observation to establish a real evidence pointer.
    await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, collectDnsSignal: async () => successResult() });

    // Second: a failed attempt.
    const failed = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => ({ observed: false, scored: false, factsRow: null, qualityRow: null, error: 'ETIMEDOUT' }),
      now: () => '2026-07-18T00:00:00.000Z',
    });

    assert.equal(failed.ok, false);
    assert.equal(failed.observationState.status, 'failed');
    assert.equal(failed.observationState.attemptCount, 1);
    assert.equal(failed.observationState.lastFailureAt, '2026-07-18T00:00:00.000Z');
    assert.equal(failed.observationState.lastFailureReason, 'ETIMEDOUT');
    // The previous successful evidence pointer must survive untouched.
    assert.equal(failed.observationState.evidenceRef, 'signal_facts_spf:facts-1');
    assert.equal(failed.observationState.lastObservedAt, '2026-07-16T00:00:00.000Z');
  });

  test('a failure sets a retry next_due_at (OBS-103) rather than leaving it unchanged', async () => {
    const client = fakeClient();
    await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, collectDnsSignal: async () => successResult() });
    const firstNextDueAt = (await require('./store').getByOrganisationAndType('ORG-1', 'spf', { client })).nextDueAt;

    const failed = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => ({ observed: false, scored: false, factsRow: null, qualityRow: null, error: 'ETIMEDOUT' }),
      now: () => '2026-07-18T00:00:00.000Z',
    });

    assert.ok(failed.observationState.nextDueAt);
    assert.notEqual(failed.observationState.nextDueAt, firstNextDueAt);
    // Retries sooner than a full daily cycle, not further out than it.
    const delayMs = Date.parse(failed.observationState.nextDueAt) - Date.parse('2026-07-18T00:00:00.000Z');
    assert.ok(delayMs > 0);
    assert.ok(delayMs <= 24 * 60 * 60 * 1000);
  });

  test('attempt_count accumulates across consecutive failures', async () => {
    const client = fakeClient();
    await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, collectDnsSignal: async () => successResult() });
    const failingDeps = { client, adapters: ADAPTERS, collectDnsSignal: async () => ({ observed: false, scored: false, factsRow: null, qualityRow: null, error: 'NXDOMAIN' }) };
    await observeOneSignal('ORG-1', 'example.com', 'spf', failingDeps);
    const third = await observeOneSignal('ORG-1', 'example.com', 'spf', failingDeps);
    assert.equal(third.observationState.attemptCount, 2);
  });

  test('distinct failure reasons (NXDOMAIN vs ETIMEDOUT) are recorded distinctly, not collapsed', async () => {
    const client = fakeClient();
    const r1 = await observeOneSignal('ORG-1', 'example.com', 'spf', { client, adapters: ADAPTERS, collectDnsSignal: async () => ({ observed: false, scored: false, factsRow: null, qualityRow: null, error: 'NXDOMAIN' }) });
    assert.equal(r1.observationState.lastFailureReason, 'NXDOMAIN');

    const client2 = fakeClient();
    const r2 = await observeOneSignal('ORG-1', 'example.com', 'spf', { client: client2, adapters: ADAPTERS, collectDnsSignal: async () => ({ observed: false, scored: false, factsRow: null, qualityRow: null, error: 'ETIMEDOUT' }) });
    assert.equal(r2.observationState.lastFailureReason, 'ETIMEDOUT');
  });

  test('an observed-but-unscored result (Unknown != Absent: a real reading with no clean score) is NOT treated as a failure', async () => {
    const client = fakeClient();
    const result = await observeOneSignal('ORG-1', 'example.com', 'spf', {
      client, adapters: ADAPTERS,
      collectDnsSignal: async () => successResult({ scored: false, qualityRow: null, reason: 'below minimum evidence' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.observationState.status, 'observed');
  });
});

describe('observeOrganisationDnsSignals — per-organisation orchestration', () => {
  test('runs all five DNS signals and one signal failing does not affect the others', async () => {
    const client = fakeClient();
    const result = await observeOrganisationDnsSignals('ORG-1', {
      client,
      resolveDomain: () => ({ ok: true, domain: 'example.com' }),
      adapters: { spf: { tableName: 'signal_facts_spf' }, dkim: { tableName: 'signal_facts_dkim' }, dmarc: { tableName: 'signal_facts_dmarc' }, dnssec: { tableName: 'signal_facts_dnssec' }, caa: { tableName: 'signal_facts_caa' } },
      collectDnsSignal: async (domain, signal) => {
        if (signal === 'dkim') return { observed: false, scored: false, factsRow: null, qualityRow: null, error: 'ETIMEDOUT' };
        return successResult({ factsRow: { id: `facts-${signal}`, domain, collected_at: '2026-07-16T00:00:00.000Z', collector_version: `${signal}-collector@1.0.0` }, qualityRow: { id: `quality-${signal}` } });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.results.length, 5);
    const dkimResult = result.results.find((r) => r.signal === 'dkim');
    const spfResult = result.results.find((r) => r.signal === 'spf');
    assert.equal(dkimResult.ok, false);
    assert.equal(spfResult.ok, true);
  });

  test('an organisation with no resolvable domain attempts zero signals', async () => {
    const client = fakeClient();
    let collectCalled = false;
    const result = await observeOrganisationDnsSignals('ORG-NO-DOMAIN', {
      client,
      resolveDomain: () => ({ ok: false, error: 'organisation ORG-NO-DOMAIN has no verifiedDomain' }),
      collectDnsSignal: async () => { collectCalled = true; return successResult(); },
    });
    assert.equal(result.ok, false);
    assert.equal(collectCalled, false);
  });
});

describe('observeOrganisationDnsSignals — bounded signal subset (OBS-103 cadence-safety fix)', () => {
  const ALL_ADAPTERS = { spf: { tableName: 'signal_facts_spf' }, dkim: { tableName: 'signal_facts_dkim' }, dmarc: { tableName: 'signal_facts_dmarc' }, dnssec: { tableName: 'signal_facts_dnssec' }, caa: { tableName: 'signal_facts_caa' } };

  test('no signalTypes given — regression: still runs all five, unchanged from before this fix (manual OBS-102 callers unaffected)', async () => {
    const client = fakeClient();
    const collected = [];
    const result = await observeOrganisationDnsSignals('ORG-1', {
      client, adapters: ALL_ADAPTERS,
      resolveDomain: () => ({ ok: true, domain: 'example.com' }),
      collectDnsSignal: async (domain, signal) => { collected.push(signal); return successResult({ factsRow: { id: `facts-${signal}`, domain, collected_at: '2026-07-16T00:00:00.000Z', collector_version: `${signal}-collector@1.0.0` }, qualityRow: { id: `quality-${signal}` } }); },
    });
    assert.equal(result.results.length, 5);
    assert.deepStrictEqual(collected.sort(), ['caa', 'dkim', 'dmarc', 'dnssec', 'spf']);
  });

  test('an explicit subset runs only that subset — the daily-only case', async () => {
    const client = fakeClient();
    const collected = [];
    const result = await observeOrganisationDnsSignals('ORG-1', {
      client, adapters: ALL_ADAPTERS, signalTypes: ['spf', 'dkim', 'dmarc'],
      resolveDomain: () => ({ ok: true, domain: 'example.com' }),
      collectDnsSignal: async (domain, signal) => { collected.push(signal); return successResult({ factsRow: { id: `facts-${signal}`, domain, collected_at: '2026-07-16T00:00:00.000Z', collector_version: `${signal}-collector@1.0.0` }, qualityRow: { id: `quality-${signal}` } }); },
    });
    assert.equal(result.results.length, 3);
    assert.deepStrictEqual(collected.sort(), ['dkim', 'dmarc', 'spf']);
    assert.ok(!collected.includes('dnssec'));
    assert.ok(!collected.includes('caa'));
  });

  test('a single-signal subset (DNSSEC only) runs only DNSSEC', async () => {
    const client = fakeClient();
    const collected = [];
    await observeOrganisationDnsSignals('ORG-1', {
      client, adapters: ALL_ADAPTERS, signalTypes: ['dnssec'],
      resolveDomain: () => ({ ok: true, domain: 'example.com' }),
      collectDnsSignal: async (domain, signal) => { collected.push(signal); return successResult({ factsRow: { id: `facts-${signal}`, domain, collected_at: '2026-07-16T00:00:00.000Z', collector_version: `${signal}-collector@1.0.0` }, qualityRow: { id: `quality-${signal}` } }); },
    });
    assert.deepStrictEqual(collected, ['dnssec']);
  });

  test('rejects an empty signalTypes array', async () => {
    const client = fakeClient();
    await assert.rejects(
      () => observeOrganisationDnsSignals('ORG-1', { client, signalTypes: [], resolveDomain: () => ({ ok: true, domain: 'example.com' }) }),
      /non-empty array/,
    );
  });

  test('rejects an unsupported observation type', async () => {
    const client = fakeClient();
    await assert.rejects(
      () => observeOrganisationDnsSignals('ORG-1', { client, signalTypes: ['spf', 'mtasts'], resolveDomain: () => ({ ok: true, domain: 'example.com' }) }),
      /unsupported observation type/,
    );
  });

  test('rejects a duplicate observation type', async () => {
    const client = fakeClient();
    await assert.rejects(
      () => observeOrganisationDnsSignals('ORG-1', { client, signalTypes: ['spf', 'spf'], resolveDomain: () => ({ ok: true, domain: 'example.com' }) }),
      /duplicates/,
    );
  });
});
