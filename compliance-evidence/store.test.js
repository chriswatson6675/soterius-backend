'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { recordEvent, getEvents, getLastReviewedAt } = require('./store');

// Minimal fake Supabase client for compliance_evidence_events: supports the
// exact chains this module uses — .insert(row).select(cols).single(); and
// .select(cols).eq().order().limit()/.then().
function fakeClient() {
  const rows = [];
  return {
    _rows: rows,
    from(table) {
      if (table !== 'compliance_evidence_events') throw new Error(`unexpected table ${table}`);
      return {
        insert(row) {
          const full = {
            id: randomUUID(),
            reviewed_at: '2026-07-13T00:00:00.000Z',
            created_at: '2026-07-13T00:00:00.000Z',
            ...row,
          };
          return {
            select() {
              return {
                single() {
                  rows.push(full);
                  return Promise.resolve({ data: full, error: null });
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

describe('recordEvent — append-only', () => {
  test('persists an event and returns it in camelCase shape', async () => {
    const client = fakeClient();
    const event = await recordEvent({
      organisationId: 'ORG-1',
      customerId: 'cust-1',
      reviewedByUserId: 'user-1',
      trustProfileGeneratedAt: '2026-07-01T00:00:00.000Z',
      type: 'review_completed',
      note: 'Checked DMARC finding with the client.',
    }, { client });

    assert.strictEqual(event.organisationId, 'ORG-1');
    assert.strictEqual(event.customerId, 'cust-1');
    assert.strictEqual(event.reviewedByUserId, 'user-1');
    assert.strictEqual(event.trustProfileGeneratedAt, '2026-07-01T00:00:00.000Z');
    assert.strictEqual(event.type, 'review_completed');
    assert.strictEqual(event.note, 'Checked DMARC finding with the client.');
    assert.ok(event.id);
    assert.ok(event.reviewedAt);
  });

  test('defaults type to review_completed when not supplied', async () => {
    const client = fakeClient();
    const event = await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    assert.strictEqual(event.type, 'review_completed');
  });

  test('note and trustProfileGeneratedAt are honestly null, not fabricated, when absent', async () => {
    const client = fakeClient();
    const event = await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    assert.strictEqual(event.note, null);
    assert.strictEqual(event.trustProfileGeneratedAt, null);
  });

  test('module exposes no update or delete function — append-only by construction', () => {
    const store = require('./store');
    assert.strictEqual(store.update, undefined);
    assert.strictEqual(store.delete, undefined);
  });
});

describe('getEvents', () => {
  test('returns every event for an organisation, newest-first', async () => {
    const client = fakeClient();
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    client._rows[0].reviewed_at = '2026-07-01T00:00:00.000Z';
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    client._rows[1].reviewed_at = '2026-07-10T00:00:00.000Z';

    const events = await getEvents('cust-1', 'ORG-1', { client });
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].reviewedAt, '2026-07-10T00:00:00.000Z');
    assert.strictEqual(events[1].reviewedAt, '2026-07-01T00:00:00.000Z');
  });

  test('an organisation with no events → empty array, never an error', async () => {
    const client = fakeClient();
    const events = await getEvents('cust-1', 'ORG-NEVER-REVIEWED', { client });
    assert.deepStrictEqual(events, []);
  });

  test('one organisation\'s events never leak into another\'s read', async () => {
    const client = fakeClient();
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    const events = await getEvents('cust-1', 'ORG-2', { client });
    assert.deepStrictEqual(events, []);
  });

  test('one customer never sees another customer\'s review for the same organisation', async () => {
    const client = fakeClient();
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    const events = await getEvents('cust-2', 'ORG-1', { client });
    assert.deepStrictEqual(events, []);
  });
});

describe('getLastReviewedAt — the derived value the Review Queue is built from', () => {
  test('no events yet → null, an honest state, never an error or a fabricated date', async () => {
    const client = fakeClient();
    const result = await getLastReviewedAt('cust-1', 'ORG-1', { client });
    assert.strictEqual(result, null);
  });

  test('returns the single most recent reviewed_at, not the full log', async () => {
    const client = fakeClient();
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    client._rows[0].reviewed_at = '2026-07-01T00:00:00.000Z';
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });
    client._rows[1].reviewed_at = '2026-07-10T00:00:00.000Z';

    const result = await getLastReviewedAt('cust-1', 'ORG-1', { client });
    assert.strictEqual(result, '2026-07-10T00:00:00.000Z');
  });

  test('does not return another customer\'s last reviewed timestamp for the same organisation', async () => {
    const client = fakeClient();
    await recordEvent({ organisationId: 'ORG-1', customerId: 'cust-1', reviewedByUserId: 'user-1' }, { client });

    const result = await getLastReviewedAt('cust-2', 'ORG-1', { client });
    assert.strictEqual(result, null);
  });
});
