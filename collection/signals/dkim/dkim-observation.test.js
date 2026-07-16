'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { persistDkimKeys, dkimAdapter } = require('./dkim-observation');

// Minimal fake Supabase client for signal_facts_dkim_keys: supports
// .select('selector').eq('dkim_run_id', x) (awaited directly, matching
// Supabase's own thenable query builder) and .insert(row).
function fakeClientV2(seedRows = []) {
  const rows = [...seedRows];
  return {
    _rows: rows,
    from(table) {
      if (table !== 'signal_facts_dkim_keys') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq(col, val) {
              const data = rows.filter((r) => r[col] === val).map((r) => ({ selector: r.selector }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
        insert(row) {
          // persistDkimKeys only forwards named columns onto the row it
          // inserts, so a "should this fail" marker on the source key can't
          // survive onto `row` — key it off the selector name instead.
          if (row.selector.startsWith('bad')) return Promise.resolve({ error: { message: `insert rejected for ${row.selector}` } });
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

function key(selector, overrides = {}) {
  return {
    selector, raw_record: `v=DKIM1; p=${selector}`, parse_success: true, version: 'DKIM1',
    key_type: 'rsa', key_bits: 1024, public_key_present: true,
    hash_algorithms: null, service_type: null, flags: null, syntax_errors: [],
    ...overrides,
  };
}

describe('persistDkimKeys — parent-child linkage (regression test for the OBS-102 trial defect)', () => {
  test('a single discovered key persists with dkim_run_id set to the parent observation row id, not a collection run id', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [key('selector1')] };
    const result = await persistDkimKeys({ observationId: 'facts-row-id-123', domain: 'example.com', facts, run: { id: 'unrelated-collection-run-id' }, observedAt: '2026-07-16T00:00:00.000Z', client });

    assert.equal(result.attempted, 1);
    assert.equal(result.persisted, 1);
    assert.equal(result.failed, 0);
    assert.equal(client._rows.length, 1);
    assert.equal(client._rows[0].dkim_run_id, 'facts-row-id-123');
    assert.notEqual(client._rows[0].dkim_run_id, 'unrelated-collection-run-id');
  });

  test('multiple discovered keys all persist, each referencing the same parent row id', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [key('selector1'), key('selector2'), key('k2')] };
    const result = await persistDkimKeys({ observationId: 'facts-row-id-abc', domain: 'poolealcock.co.uk', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });

    assert.equal(result.persisted, 3);
    assert.equal(client._rows.length, 3);
    assert.ok(client._rows.every((r) => r.dkim_run_id === 'facts-row-id-abc'));
    assert.deepStrictEqual(client._rows.map((r) => r.selector).sort(), ['k2', 'selector1', 'selector2']);
  });

  test('throws if observationId is missing rather than silently falling back to anything else', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [key('selector1')] };
    await assert.rejects(
      () => persistDkimKeys({ domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client }),
      /observationId .* is required/,
    );
    assert.equal(client._rows.length, 0);
  });
});

describe('persistDkimKeys — Unknown != Absent', () => {
  test('no discovered selectors produces no child rows and no error', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [] };
    const result = await persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });
    assert.equal(result.attempted, 0);
    assert.equal(result.persisted, 0);
    assert.equal(result.failed, 0);
    assert.equal(client._rows.length, 0);
  });

  test('a missing dkim_keys field (not an array) is treated the same as none found', async () => {
    const client = fakeClientV2();
    const facts = { dkim_present: null };
    const result = await persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });
    assert.equal(result.attempted, 0);
    assert.equal(client._rows.length, 0);
  });
});

describe('persistDkimKeys — partial and complete failure', () => {
  test('a partial failure persists every valid key and throws, reporting exact counts', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [key('good1'), key('bad1'), key('good2')] };
    await assert.rejects(
      () => persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client }),
      /partial failure — 2 persisted, 0 skipped \(already present\), 1 failed/,
    );
    assert.equal(client._rows.length, 2);
    assert.deepStrictEqual(client._rows.map((r) => r.selector).sort(), ['good1', 'good2']);
  });

  test('a complete failure (every key fails) throws and reports zero persisted', async () => {
    const client = fakeClientV2();
    const facts = { dkim_keys: [key('bad1'), key('bad2')] };
    await assert.rejects(
      () => persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client }),
      /complete failure — 0 persisted, 0 skipped \(already present\), 2 failed/,
    );
    assert.equal(client._rows.length, 0);
  });
});

describe('persistDkimKeys — idempotent retry', () => {
  test('re-running the same collection result does not duplicate already-persisted selectors', async () => {
    const client = fakeClientV2([{ dkim_run_id: 'facts-row-1', selector: 'selector1' }]);
    const facts = { dkim_keys: [key('selector1'), key('selector2')] };
    const result = await persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });

    assert.equal(result.skipped, 1);
    assert.equal(result.persisted, 1);
    assert.equal(client._rows.length, 2); // the pre-existing row + exactly one new row
    assert.deepStrictEqual(client._rows.map((r) => r.selector).sort(), ['selector1', 'selector2']);
  });

  test('a fully-duplicate retry persists zero new rows and is not an error', async () => {
    const client = fakeClientV2([
      { dkim_run_id: 'facts-row-1', selector: 'selector1' },
      { dkim_run_id: 'facts-row-1', selector: 'selector2' },
    ]);
    const facts = { dkim_keys: [key('selector1'), key('selector2')] };
    const result = await persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });

    assert.equal(result.skipped, 2);
    assert.equal(result.persisted, 0);
    assert.equal(client._rows.length, 2);
  });

  test('duplicate-checking is scoped to the parent row id — a different parent\'s identical selector is not treated as a duplicate', async () => {
    const client = fakeClientV2([{ dkim_run_id: 'facts-row-OTHER', selector: 'selector1' }]);
    const facts = { dkim_keys: [key('selector1')] };
    const result = await persistDkimKeys({ observationId: 'facts-row-1', domain: 'example.com', facts, run: { id: 'run-x' }, observedAt: '2026-07-16T00:00:00.000Z', client });

    assert.equal(result.skipped, 0);
    assert.equal(result.persisted, 1);
  });
});

describe('dkimAdapter wiring', () => {
  test('the adapter still exposes persistChildren as persistDkimKeys (the Collection Session\'s call contract is unchanged)', () => {
    assert.equal(dkimAdapter.persistChildren, persistDkimKeys);
  });

  test('nationalAdapters() — used by both the on-demand pipeline and OBS-102 — exposes the exact same fixed persistDkimKeys, not a separate copy', () => {
    const { nationalAdapters } = require('../../runs/national/run-national');
    assert.equal(nationalAdapters().dkim.persistChildren, persistDkimKeys);
  });

  test('SPF/DMARC/DNSSEC/CAA adapters define no persistChildren — untouched by this fix, no child-table concept for them', () => {
    const { nationalAdapters } = require('../../runs/national/run-national');
    const adapters = nationalAdapters();
    assert.equal(adapters.spf.persistChildren, undefined);
    assert.equal(adapters.dmarc.persistChildren, undefined);
    assert.equal(adapters.dnssec.persistChildren, undefined);
    assert.equal(adapters.caa.persistChildren, undefined);
  });
});
