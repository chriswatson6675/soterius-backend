'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { insert, getByOrganisationAndType, update, getAllByOrganisation, claim } = require('./store');
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
            in(col, vals) {
              filtered = filtered.filter((r) => vals.includes(r[col]));
              return builder;
            },
            maybeSingle() {
              return Promise.resolve({ data: filtered[0] || null, error: null });
            },
            then(onFulfilled) {
              // Awaited directly (no terminal call) — e.g. getAllByOrganisation.
              return Promise.resolve({ data: filtered, error: null }).then(onFulfilled);
            },
          };
          return builder;
        },
        update(patch) {
          let filtered = rows;
          const builder = {
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return builder;
            },
            neq(col, val) {
              filtered = filtered.filter((r) => r[col] !== val);
              return builder;
            },
            // Fake `.or('status.neq.running,updated_at.lt.X')` — parses just
            // enough of the real PostgREST filter syntax for the two clauses
            // claim() actually sends.
            or(expr) {
              const clauses = expr.split(',').map((c) => {
                const [col, op, val] = c.split('.');
                return { col, op, val };
              });
              filtered = filtered.filter((r) => clauses.some(({ col, op, val }) => {
                if (op === 'neq') return r[col] !== val;
                if (op === 'lt') return r[col] < val;
                return false;
              }));
              return builder;
            },
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

describe('update', () => {
  test('updates only the fields present in the patch, leaving others untouched', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });

    const updated = await update('ORG-1', 'spf', { status: 'observed', lastObservedAt: '2026-07-16T00:00:00.000Z' }, { client });
    assert.equal(updated.status, 'observed');
    assert.equal(updated.lastObservedAt, '2026-07-16T00:00:00.000Z');
    assert.equal(updated.collectionGroup, 'dns_batch'); // untouched by the patch
  });

  test('throws when no row exists yet for the (organisationId, observationType) pair', async () => {
    const client = fakeClient();
    await assert.rejects(() => update('ORG-1', 'spf', { status: 'observed' }, { client }), /no existing row/);
  });

  test('a second update composes on top of the first (re-observation advances the same row)', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    await update('ORG-1', 'spf', { status: 'observed', attemptCount: 0 }, { client });
    const second = await update('ORG-1', 'spf', { status: 'failed', attemptCount: 1, lastFailureReason: 'NXDOMAIN' }, { client });
    assert.equal(second.status, 'failed');
    assert.equal(second.attemptCount, 1);
    assert.equal(second.lastFailureReason, 'NXDOMAIN');
  });
});

describe('getAllByOrganisation', () => {
  test('returns every row for the organisation restricted to the given observation types', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'dkim', collectionGroup: 'dns_batch' }), { client });
    await insert(createObservationState({ organisationId: 'ORG-2', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });

    const rows = await getAllByOrganisation('ORG-1', ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'], { client });
    assert.equal(rows.length, 2);
    assert.deepStrictEqual(rows.map((r) => r.observationType).sort(), ['dkim', 'spf']);
  });

  test('returns an empty array, never an error, when nothing exists yet', async () => {
    const client = fakeClient();
    const rows = await getAllByOrganisation('ORG-1', ['spf'], { client });
    assert.deepStrictEqual(rows, []);
  });
});

describe('claim', () => {
  test('claims a row whose status is not running or suspended', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    const claimed = await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:00:00.000Z', leaseMs: 900000 }, { client });
    assert.ok(claimed);
    assert.equal(claimed.status, 'running');
  });

  test('refuses to claim a row already running and not yet stale', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:00:00.000Z', leaseMs: 900000 }, { client });
    const secondClaim = await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:05:00.000Z', leaseMs: 900000 }, { client });
    assert.equal(secondClaim, null);
  });

  test('reclaims a stale running row (crashed worker) past the lease duration', async () => {
    const client = fakeClient();
    await insert(createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' }), { client });
    await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:00:00.000Z', leaseMs: 900000 }, { client });
    // 20 minutes later — past a 15-minute lease.
    const reclaimed = await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:20:00.000Z', leaseMs: 900000 }, { client });
    assert.ok(reclaimed);
    assert.equal(reclaimed.status, 'running');
  });

  test('refuses to claim a suspended row', async () => {
    const client = fakeClient();
    const record = createObservationState({ organisationId: 'ORG-1', observationType: 'spf', collectionGroup: 'dns_batch' });
    await insert(record, { client });
    await update('ORG-1', 'spf', { status: 'suspended' }, { client });
    const claimed = await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:00:00.000Z', leaseMs: 900000 }, { client });
    assert.equal(claimed, null);
  });

  test('returns null, not an error, for a row that does not exist', async () => {
    const client = fakeClient();
    const claimed = await claim('ORG-1', 'spf', { nowIso: '2026-07-16T00:00:00.000Z', leaseMs: 900000 }, { client });
    assert.equal(claimed, null);
  });
});

// ---- OBS-103 BLOCKER 1: truncation-proof provisioned-id retrieval ----

const { listProvisionedOrganisationIds } = require('./store');

// A faithful paging client: honours .select(cols,{count}).order().range(a,b),
// returning the exact window and an exact total count — like PostgREST when you
// page correctly.
function pagingClient(rows, { countOverride = null } = {}) {
  return {
    from(table) {
      if (table !== 'observation_states') throw new Error(`unexpected table ${table}`);
      const q = {
        _count: false,
        _range: null,
        select(_cols, opts) { if (opts && opts.count) q._count = true; return q; },
        order() { return q; },
        range(a, b) { q._range = [a, b]; return q; },
        then(res, rej) {
          const [a, b] = q._range;
          const data = rows.slice(a, b + 1);
          const count = q._count ? (countOverride ?? rows.length) : null;
          return Promise.resolve({ data, error: null, count }).then(res, rej);
        },
      };
      return q;
    },
  };
}

// A BROKEN client that IGNORES .range() and always returns the first `cap` rows
// — exactly the silent-truncation defect the old unbounded .select() hit against
// Supabase's default 1000-row cap.
function truncatingClient(rows, cap = 1000) {
  return {
    from() {
      const q = {
        _count: false,
        select(_cols, opts) { if (opts && opts.count) q._count = true; return q; },
        order() { return q; },
        range() { return q; },
        then(res, rej) {
          const count = q._count ? rows.length : null;
          return Promise.resolve({ data: rows.slice(0, cap), error: null, count }).then(res, rej);
        },
      };
      return q;
    },
  };
}

function makeStateRows(orgCount, perOrg = 5) {
  const rows = [];
  let id = 0;
  for (let o = 0; o < orgCount; o += 1) {
    for (let s = 0; s < perOrg; s += 1) {
      rows.push({ id: String(id).padStart(8, '0'), organisation_id: `ORG-${String(o).padStart(6, '0')}` });
      id += 1;
    }
  }
  return rows;
}

describe('listProvisionedOrganisationIds — truncation-proof', () => {
  test('retrieves EVERY distinct organisation id beyond 80,835 states (16,167 orgs × 5)', async () => {
    const rows = makeStateRows(16167, 5); // 80,835 rows
    assert.equal(rows.length, 80835);
    const ids = await listProvisionedOrganisationIds({ client: pagingClient(rows), pageSize: 1000 });
    assert.equal(ids.length, 16167);
    assert.ok(ids.includes('ORG-000000'));
    assert.ok(ids.includes('ORG-016166'));
  });

  test('small page size still returns the complete distinct set', async () => {
    const rows = makeStateRows(250, 5); // 1,250 rows
    const ids = await listProvisionedOrganisationIds({ client: pagingClient(rows), pageSize: 100 });
    assert.equal(ids.length, 250);
  });

  test('reproduces the previous defect: a client that ignores range FAILS LOUDLY (never silently truncates)', async () => {
    const rows = makeStateRows(1000, 5); // 5,000 rows, cap 1000
    await assert.rejects(
      () => listProvisionedOrganisationIds({ client: truncatingClient(rows, 1000), pageSize: 1000 }),
      /stalled|incomplete/,
    );
  });

  test('detects short coverage: retrieved rows fewer than the reported exact count → throws', async () => {
    const rows = makeStateRows(500, 5); // 2,500 rows, but pretend the table really has 3,000
    await assert.rejects(
      () => listProvisionedOrganisationIds({ client: pagingClient(rows, { countOverride: 3000 }), pageSize: 1000 }),
      /incomplete/,
    );
  });

  test('surfaces a client error rather than returning a partial set', async () => {
    const errClient = { from() { return { select() { return this; }, order() { return this; }, range() { return this; }, then(res, rej) { return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej); } }; } };
    await assert.rejects(() => listProvisionedOrganisationIds({ client: errClient, pageSize: 1000 }), /provisioned-ids read failed: boom/);
  });
});
