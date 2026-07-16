'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { insert, getByOrganisationAndType } = require('./store');
const { createObservationState } = require('./observation-state');

// Minimal fake Supabase client: an in-memory array acting as the
// observation_states table. Supports the exact chain this module uses:
// .insert(row).select().single(); .select().eq().eq().maybeSingle().
function fakeClient() {
  const rows = [];
  let nextId = 1;
  return {
    _rows: rows,
    from(table) {
      if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
      return {
        insert(row) {
          const duplicate = rows.some(
            (r) => r.organisation_id === row.organisation_id && r.observation_type === row.observation_type,
          );
          return {
            select() {
              return {
                single() {
                  if (duplicate) {
                    return Promise.resolve({ data: null, error: { message: 'duplicate key value violates unique constraint "uq_observation_states_org_type"' } });
                  }
                  const stored = { id: String(nextId++), created_at: '2026-07-16T00:00:00.000Z', updated_at: '2026-07-16T00:00:00.000Z', ...row };
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
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return builder;
            },
            maybeSingle() {
              return Promise.resolve({ data: filtered[0] || null, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

describe('insert / getByOrganisationAndType', () => {
  test('a never-yet-observed Observation State can be inserted and read back', async () => {
    const client = fakeClient();
    const record = createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' });
    const inserted = await insert(record, { client });
    assert.equal(inserted.organisationId, 'ORG-1');
    assert.equal(inserted.status, 'never_observed');
    assert.ok(inserted.id);

    const fetched = await getByOrganisationAndType('ORG-1', 'spf', { client });
    assert.equal(fetched.organisationId, 'ORG-1');
    assert.equal(fetched.observationType, 'spf');
    assert.equal(fetched.status, 'never_observed');
  });

  test('getByOrganisationAndType returns null, never an error, when no row exists yet', async () => {
    const client = fakeClient();
    const result = await getByOrganisationAndType('ORG-1', 'spf', { client });
    assert.equal(result, null);
  });

  test('inserting a duplicate (organisationId, observationType) pair throws', async () => {
    const client = fakeClient();
    const record = createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' });
    await insert(record, { client });
    await assert.rejects(() => insert(record, { client }), /observation_states insert failed/);
  });

  test('one organisation\'s row never leaks into another organisation\'s read', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    const result = await getByOrganisationAndType('ORG-2', 'spf', { client });
    assert.equal(result, null);
  });

  test('the same organisation can have independent Observation States per observation type', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'companies_house', collectionGroup: 'companies_house' }), { client });
    const spf = await getByOrganisationAndType('ORG-1', 'spf', { client });
    const ch = await getByOrganisationAndType('ORG-1', 'companies_house', { client });
    assert.equal(spf.collectionGroup, 'dns_batch');
    assert.equal(ch.collectionGroup, 'companies_house');
  });
});
