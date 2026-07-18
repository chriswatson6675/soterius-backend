'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  enumerateEligibleOrganisations, provisionObservationStates, buildInitialStateRecord,
} = require('./provision-states');
const shard = require('./shard-assignment');

const NOW = '2026-03-10T12:00:00.000Z';
const TYPES = ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'];

function memStore() {
  const rows = [];
  return {
    rows,
    async getAllByOrganisation(orgId, types) {
      return rows.filter((r) => r.organisationId === orgId && types.includes(r.observationType)).map((r) => ({ ...r }));
    },
    async insert(record) {
      if (rows.some((r) => r.organisationId === record.organisationId && r.observationType === record.observationType)) {
        throw new Error('duplicate key value violates unique constraint');
      }
      rows.push({ ...record });
      return { ...record };
    },
  };
}

function fakeResolve() {
  const resolved = { 'org-a.com': 'ORG-A', 'org-b.com': 'ORG-B', 'org-c.com': 'ORG-C' };
  return {
    listOrganisationIds: () => ['ORG-A', 'ORG-B', 'ORG-C', 'ORG-D', 'ORG-E'],
    reverse: (id) => (id === 'ORG-E'
      ? { ok: true, row: {} } // no verifiedDomain
      : { ok: true, row: { verifiedDomain: `${id.toLowerCase()}.com` } }),
    resolveOrganisationByDomain: (d) => (resolved[d]
      ? { outcome: 'RESOLVED', organisationId: resolved[d] }
      : { outcome: 'AMBIGUOUS', organisationId: null }), // ORG-D → contested/ambiguous
  };
}

describe('enumerateEligibleOrganisations', () => {
  test('includes only single-verified-uncontested-resolvable orgs; excludes ambiguous and domain-less', () => {
    const eligible = enumerateEligibleOrganisations({ resolve: fakeResolve() });
    assert.deepEqual(eligible.map((e) => e.organisationId), ['ORG-A', 'ORG-B', 'ORG-C']);
    assert.equal(eligible.find((e) => e.organisationId === 'ORG-A').domain, 'org-a.com');
  });
});

describe('buildInitialStateRecord', () => {
  test('never-observed with next_due on the org daily slot within 24h', () => {
    const rec = buildInitialStateRecord('ORG-A', 'spf', NOW);
    assert.equal(rec.status, 'never_observed');
    assert.equal(rec.lastObservedAt, null);
    const due = Date.parse(rec.nextDueAt);
    assert.ok(due > Date.parse(NOW) && due - Date.parse(NOW) <= 24 * 60 * 60 * 1000);
    const d = new Date(due);
    assert.equal(d.getUTCHours() * 4 + d.getUTCMinutes() / 15, shard.dailySlotIndex('ORG-A'));
  });
  test('weekly initial next_due on the org weekly slot within 7d', () => {
    const rec = buildInitialStateRecord('ORG-A', 'dnssec', NOW);
    const due = Date.parse(rec.nextDueAt);
    assert.ok(due - Date.parse(NOW) <= 7 * 24 * 60 * 60 * 1000);
    assert.equal((due - shard.EPOCH_ANCHOR_MS) % (7 * 24 * 60 * 60 * 1000), shard.weeklySlotIndex('ORG-A') * shard.SLOT_MS);
  });
});

describe('provisionObservationStates', () => {
  const eligible = [{ organisationId: 'ORG-A' }, { organisationId: 'ORG-B' }, { organisationId: 'ORG-C' }];

  test('dry-run writes nothing but reports the full plan (5 per org)', async () => {
    const store = memStore();
    const s = await provisionObservationStates({ nowIso: NOW, dryRun: true }, { store, eligible });
    assert.equal(s.statesToCreate, 15);
    assert.equal(s.statesCreated, 0);
    assert.equal(store.rows.length, 0);
    assert.equal(s.dryRun, true);
  });

  test('real run creates exactly 5 states per eligible org', async () => {
    const store = memStore();
    const s = await provisionObservationStates({ nowIso: NOW, dryRun: false }, { store, eligible });
    assert.equal(s.statesCreated, 15);
    assert.equal(store.rows.length, 15);
    for (const org of ['ORG-A', 'ORG-B', 'ORG-C']) {
      const got = store.rows.filter((r) => r.organisationId === org).map((r) => r.observationType).sort();
      assert.deepEqual(got, [...TYPES].sort());
    }
  });

  test('idempotent rerun creates nothing new and does not duplicate', async () => {
    const store = memStore();
    await provisionObservationStates({ nowIso: NOW, dryRun: false }, { store, eligible });
    const s2 = await provisionObservationStates({ nowIso: '2026-03-11T00:00:00.000Z', dryRun: false }, { store, eligible });
    assert.equal(s2.statesCreated, 0);
    assert.equal(s2.organisationsAlreadyComplete, 3);
    assert.equal(store.rows.length, 15);
  });

  test('preserves existing pilot state and its evidence pointer', async () => {
    const store = memStore();
    // pre-seed ORG-A/spf as an already-observed pilot state with evidence
    store.rows.push({ organisationId: 'ORG-A', observationType: 'spf', status: 'observed', nextDueAt: '2030-01-01T00:00:00.000Z', evidenceRef: 'signal_facts_spf:pilot-1', lastObservedAt: '2026-03-09T00:00:00.000Z' });
    await provisionObservationStates({ nowIso: NOW, dryRun: false }, { store, eligible });
    const pilot = store.rows.find((r) => r.organisationId === 'ORG-A' && r.observationType === 'spf');
    assert.equal(pilot.status, 'observed');
    assert.equal(pilot.evidenceRef, 'signal_facts_spf:pilot-1');
    assert.equal(pilot.nextDueAt, '2030-01-01T00:00:00.000Z'); // untouched
    // the other 14 states created around it
    assert.equal(store.rows.length, 15);
  });

  test('interrupted then resumed provisioning converges to 5N with no duplicates', async () => {
    const store = memStore();
    // Phase 1: only ORG-A provisioned (limit 1)
    const p1 = await provisionObservationStates({ nowIso: NOW, dryRun: false, limit: 1 }, { store, eligible });
    assert.equal(p1.statesCreated, 5);
    // Resume: full run completes the rest, no duplicates
    const p2 = await provisionObservationStates({ nowIso: NOW, dryRun: false }, { store, eligible });
    assert.equal(p2.statesCreated, 10);
    assert.equal(store.rows.length, 15);
    assert.equal(new Set(store.rows.map((r) => `${r.organisationId}:${r.observationType}`)).size, 15);
  });

  test('reconciliation totals for N eligible: orgs N, states 5N, daily 3N, weekly 2N', async () => {
    const N = 50;
    const many = Array.from({ length: N }, (_, i) => ({ organisationId: `ORG-${String(i).padStart(4, '0')}` }));
    const store = memStore();
    const s = await provisionObservationStates({ nowIso: NOW, dryRun: false, batchSize: 20 }, { store, eligible: many });
    assert.equal(s.eligibleOrganisations, N);
    assert.equal(s.statesCreated, 5 * N);
    const daily = store.rows.filter((r) => ['spf', 'dkim', 'dmarc'].includes(r.observationType)).length;
    const weekly = store.rows.filter((r) => ['dnssec', 'caa'].includes(r.observationType)).length;
    assert.equal(daily, 3 * N);
    assert.equal(weekly, 2 * N);
    assert.ok(s.batches >= 3);
  });
});
