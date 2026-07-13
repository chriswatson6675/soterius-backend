'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { save, getCurrent, getHistory } = require('./store');

// Minimal fake Supabase client: an in-memory array acting as the
// trust_profile_instances table. Supports the exact chain this module uses:
// .insert(row); .select().eq().order().limit(); .select().eq().order().
function fakeClient() {
  const rows = [];
  return {
    _rows: rows,
    from(table) {
      if (table !== 'trust_profile_instances') throw new Error(`unexpected table ${table}`);
      return {
        insert(row) {
          if (rows.some((r) => r.organisation_id === row.organisation_id && r.generated_at === row.generated_at)) {
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
          }
          rows.push(row);
          return Promise.resolve({ error: null });
        },
        select() {
          let filtered = rows;
          const builder = {
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return builder;
            },
            order(col, { ascending }) {
              filtered = [...filtered].sort((a, b) => {
                if (a[col] === b[col]) return 0;
                return ascending ? (a[col] < b[col] ? -1 : 1) : (a[col] > b[col] ? -1 : 1);
              });
              return builder;
            },
            limit(n) {
              return Promise.resolve({ data: filtered.slice(0, n), error: null });
            },
            then(resolve) {
              resolve({ data: filtered, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

describe('save / getCurrent — TI-P-4/TI-P-5 append-only, ENG-023 §12 resolution', () => {
  test('no instances yet → honest "none generated" state, never an error', async () => {
    const client = fakeClient();
    const result = await getCurrent('ORG-1', { client });
    assert.deepStrictEqual(result, { exists: false });
  });

  test('one saved instance is resolvable as current', async () => {
    const client = fakeClient();
    const instance = { organisationId: 'ORG-1', generatedAt: '2026-07-01T00:00:00.000Z', trigger: 'scheduled' };
    await save(instance, { client });
    const result = await getCurrent('ORG-1', { client });
    assert.strictEqual(result.exists, true);
    assert.deepStrictEqual(result.instance, instance);
  });

  test('the instance with the latest generatedAt resolves as current, per ENG-023 §12', async () => {
    const client = fakeClient();
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-01T00:00:00.000Z', trigger: 'scheduled' }, { client });
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-10T00:00:00.000Z', trigger: 'scheduled' }, { client });
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-05T00:00:00.000Z', trigger: 'on-demand' }, { client });
    const result = await getCurrent('ORG-1', { client });
    assert.strictEqual(result.generatedAt, '2026-07-10T00:00:00.000Z');
  });

  test('history is retained in full, ordered oldest-first, nothing overwritten', async () => {
    const client = fakeClient();
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-01T00:00:00.000Z', trigger: 'scheduled' }, { client });
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-10T00:00:00.000Z', trigger: 'scheduled' }, { client });
    const history = await getHistory('ORG-1', { client });
    assert.strictEqual(history.length, 2);
    assert.deepStrictEqual(history.map((h) => h.generatedAt), ['2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z']);
  });

  test('one Organisation\'s instances never leak into another\'s current-resolution read', async () => {
    const client = fakeClient();
    await save({ organisationId: 'ORG-1', generatedAt: '2026-07-10T00:00:00.000Z', trigger: 'scheduled' }, { client });
    const result = await getCurrent('ORG-2', { client });
    assert.deepStrictEqual(result, { exists: false });
  });
});
