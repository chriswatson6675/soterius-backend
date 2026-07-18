'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('./provision-observation-states-cli');

const DNS_TYPES = ['spf', 'dkim', 'dmarc', 'dnssec', 'caa'];

// Fully offline resolve double: 5 eligible pilots, 150 eligible new orgs, plus
// ambiguous and domain-less organisations that must be excluded BEFORE ranking.
function makeResolve() {
  const pilots = Array.from({ length: 5 }, (_, i) => `ORG-PILOT-${i}`);
  const news = Array.from({ length: 150 }, (_, i) => `ORG-NEW-${String(i).padStart(3, '0')}`);
  const ambiguous = ['ORG-AMB-0', 'ORG-AMB-1'];
  const domainless = ['ORG-NONE-0'];
  const all = [...pilots, ...news, ...ambiguous, ...domainless];
  const resolvable = new Set([...pilots, ...news]);
  const domainFor = (id) => `${id.toLowerCase()}.example`;
  return {
    _pilots: pilots, _news: news, _ambiguous: ambiguous, _domainless: domainless,
    listOrganisationIds: () => all,
    reverse: (id) => (domainless.includes(id)
      ? { ok: true, row: {} }
      : { ok: true, row: { verifiedDomain: domainFor(id), organisationName: `${id} Ltd` } }),
    resolveOrganisationByDomain: (d) => {
      const id = d.replace('.example', '').toUpperCase();
      return resolvable.has(id)
        ? { outcome: 'RESOLVED', organisationId: id }
        : { outcome: 'AMBIGUOUS', organisationId: null };
    },
  };
}

// Fully offline observation-state store double, pre-seeded so the 5 pilots are
// already provisioned (5 observed states each, with evidence pointers).
function makeStore(preProvisioned = []) {
  const rows = [];
  for (const id of preProvisioned) {
    for (const t of DNS_TYPES) {
      rows.push({ organisationId: id, observationType: t, status: 'observed', evidenceRef: `ev:${id}:${t}`, nextDueAt: '2030-01-01T00:00:00.000Z', lastObservedAt: '2026-03-09T00:00:00.000Z' });
    }
  }
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
    async listProvisionedOrganisationIds() {
      return Array.from(new Set(rows.map((r) => r.organisationId)));
    },
  };
}

function baseDeps(overrides = {}) {
  const resolve = overrides.resolve || makeResolve();
  const store = overrides.store || makeStore(resolve._pilots);
  const logs = [];
  return {
    resolve,
    store,
    logs,
    log: (m) => logs.push(m),
    logEnvironmentConfirmation: () => {},
    ...overrides,
  };
}

describe('provision CLI --cohort-size (group C)', () => {
  test('dry-run selects exactly 100 and proposes 500 states (300 daily / 200 weekly); pilots untouched; nothing written', async () => {
    const deps = baseDeps();
    const before = deps.store.rows.length; // 25 pilot states
    const res = await cli.run({ cohortSize: 100, now: '2026-03-10T12:00:00.000Z', batchSize: 500 }, deps);

    assert.equal(res.dryRun, true);
    assert.equal(res.selection.selectedCount, 100);
    assert.equal(res.summary.statesToCreate, 500);
    assert.equal(res.summary.statesCreated, 0);
    assert.equal(res.proposedDaily, 300);
    assert.equal(res.proposedWeekly, 200);
    assert.equal(res.selection.sufficient, true);
    // Nothing written during dry-run — the 25 pilot rows are all that exist.
    assert.equal(deps.store.rows.length, before);
    // No selected organisation is a pilot.
    for (const p of deps.resolve._pilots) assert.ok(!res.selection.selected.some((s) => s.organisationId === p));
  });

  test('production write creates exactly 500 new states and leaves the five pilots byte-for-byte untouched', async () => {
    const deps = baseDeps();
    const pilotSnapshot = JSON.stringify(deps.store.rows.filter((r) => r.organisationId.startsWith('ORG-PILOT-')));
    const res = await cli.run(
      { cohortSize: 100, now: '2026-03-10T12:00:00.000Z', batchSize: 500, production: true, confirm: 'PROVISION-STATES' },
      deps,
    );
    assert.equal(res.dryRun, false);
    assert.equal(res.summary.statesCreated, 500);
    assert.equal(deps.store.rows.length, 25 + 500);
    // Pilot rows unchanged.
    assert.equal(JSON.stringify(deps.store.rows.filter((r) => r.organisationId.startsWith('ORG-PILOT-'))), pilotSnapshot);
    // Exactly 100 distinct NEW organisations, 5 states each.
    const created = deps.store.rows.filter((r) => r.organisationId.startsWith('ORG-NEW-'));
    assert.equal(created.length, 500);
    assert.equal(new Set(created.map((r) => r.organisationId)).size, 100);
  });

  test('ambiguous and domain-less organisations are excluded before ranking (never selected)', async () => {
    const deps = baseDeps();
    const res = await cli.run({ cohortSize: 155, now: '2026-03-10T12:00:00.000Z' }, deps);
    // 155 eligible (5 pilots + 150 new); pilots excluded as provisioned → 150 selectable.
    assert.equal(res.selection.eligibleCount, 155);
    assert.equal(res.selection.alreadyProvisionedCount, 5);
    assert.equal(res.selection.selectedCount, 150);
    assert.equal(res.selection.sufficient, false);
    for (const id of [...deps.resolve._ambiguous, ...deps.resolve._domainless]) {
      assert.ok(!res.selection.selected.some((s) => s.organisationId === id));
    }
  });

  test('--limit and --cohort-size together fail', async () => {
    const deps = baseDeps();
    await assert.rejects(() => cli.run({ limit: 100, cohortSize: 100 }, deps), /mutually exclusive/);
  });

  test('production without --confirm stays a dry-run (guard unchanged); nothing written', async () => {
    const deps = baseDeps();
    const res = await cli.run({ cohortSize: 10, production: true, confirm: null, now: '2026-03-10T12:00:00.000Z' }, deps);
    assert.equal(res.dryRun, true);
    assert.equal(res.summary.statesCreated, 0);
    assert.equal(deps.store.rows.length, 25);
  });

  test('invalid, zero, negative and non-integer sizes fail', async () => {
    for (const size of [0, -1, cli.strictInt('3.5'), cli.strictInt('abc')]) {
      const deps = baseDeps();
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => cli.run({ cohortSize: size }, deps), /positive integer|mutually|cohort-size/);
    }
  });

  test('manifest output is deterministic and written via injected writer', async () => {
    const writes = [];
    const deps = baseDeps();
    const res1 = await cli.run({ cohortSize: 100, manifest: 'out.json', __writeFile: (p, b) => writes.push([p, b]) }, deps);
    const deps2 = baseDeps();
    await cli.run({ cohortSize: 100, manifest: 'out.json', __writeFile: (p, b) => writes.push([p, b]) }, deps2);
    assert.equal(writes.length, 2);
    assert.equal(writes[0][0], 'out.json');
    assert.equal(writes[0][1], writes[1][1]); // byte-equivalent across runs
    assert.equal(res1.manifest.entries.length, 100);
  });
});

describe('provision CLI argument parsing', () => {
  test('parses --cohort-size and --manifest, defaults manifest-format to json', () => {
    const a = cli.parseArgs(['--cohort-size', '100', '--manifest', 'c.json']);
    assert.equal(a.cohortSize, 100);
    assert.equal(a.manifest, 'c.json');
    assert.equal(a.manifestFormat, 'json');
    assert.equal(a.limit, null);
  });

  test('strictInt rejects non-integers (fixes silent parseInt truncation)', () => {
    assert.equal(cli.strictInt('100'), 100);
    assert.ok(Number.isNaN(cli.strictInt('3.5')));
    assert.ok(Number.isNaN(cli.strictInt('abc')));
    assert.ok(Number.isNaN(cli.strictInt('')));
  });

  test('legacy --limit path still works unchanged (no cohort selection)', async () => {
    const deps = baseDeps();
    const res = await cli.run({ limit: 3, now: '2026-03-10T12:00:00.000Z' }, deps);
    assert.equal(res.mode, 'legacy');
    // dry-run legacy over the full eligible population, first-3-considered semantics preserved.
    assert.equal(res.dryRun, true);
    assert.equal(res.summary.eligibleOrganisations, 155);
  });
});
