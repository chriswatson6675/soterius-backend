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

  test('governed workflow: select → manifest → --from-manifest production write creates exactly 500; pilots untouched', async () => {
    const deps = baseDeps();
    const pilotSnapshot = JSON.stringify(deps.store.rows.filter((r) => r.organisationId.startsWith('ORG-PILOT-')));

    // Step 1 — selection produces the reviewed manifest (no writes).
    const sel = await cli.run({ cohortSize: 100, now: '2026-03-10T12:00:00.000Z' }, deps);
    assert.equal(deps.store.rows.length, 25); // selection wrote nothing
    const manifestJson = JSON.stringify(sel.manifest);

    // Step 2 — provision ONLY that manifest (same live store/deps).
    const res = await cli.run({
      fromManifest: 'phase1a.json', production: true, confirm: 'PROVISION-STATES',
      approveDigest: sel.manifest.cohortDigest, now: '2026-03-10T12:00:00.000Z',
      __readFile: () => manifestJson,
    }, deps);

    assert.equal(res.dryRun, false);
    assert.equal(res.summary.statesCreated, 500);
    assert.equal(deps.store.rows.length, 25 + 500);
    assert.equal(JSON.stringify(deps.store.rows.filter((r) => r.organisationId.startsWith('ORG-PILOT-'))), pilotSnapshot);
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

  test('--cohort-size --production is refused (selection-only; directs to the manifest flow); nothing written', async () => {
    const deps = baseDeps();
    await assert.rejects(
      () => cli.run({ cohortSize: 10, production: true, confirm: 'PROVISION-STATES', now: '2026-03-10T12:00:00.000Z' }, deps),
      /does not write in production|from-manifest/,
    );
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

describe('provision CLI manifest overwrite protection', () => {
  test('refuses to overwrite an existing manifest path without --force', async () => {
    const deps = baseDeps();
    await assert.rejects(
      () => cli.run({ cohortSize: 10, manifest: 'exists.json', __existsFile: () => true, __writeFile: () => { throw new Error('should not have written'); } }, deps),
      /already exists|--force/,
    );
  });
  test('--force permits overwrite', async () => {
    const deps = baseDeps();
    const writes = [];
    await cli.run({ cohortSize: 10, manifest: 'exists.json', force: true, __existsFile: () => true, __writeFile: (p, b) => writes.push([p, b]) }, deps);
    assert.equal(writes.length, 1);
  });
});

describe('provision CLI --from-manifest (BLOCKER 2 — governed production write)', () => {
  const NOW = '2026-03-10T12:00:00.000Z';

  // Produce a reviewed manifest against a fresh baseline (5 provisioned pilots).
  async function selectManifest() {
    const deps = baseDeps();
    const sel = await cli.run({ cohortSize: 100, now: NOW }, deps);
    return { manifestJson: JSON.stringify(sel.manifest), manifest: sel.manifest };
  }

  test('dry-run validates, reconciles, reports the plan, and writes nothing', async () => {
    const { manifestJson } = await selectManifest();
    const deps = baseDeps();
    const res = await cli.run({ fromManifest: 'p.json', now: NOW, __readFile: () => manifestJson }, deps);
    assert.equal(res.dryRun, true);
    assert.equal(res.mode, 'from-manifest');
    assert.equal(res.summary.statesToCreate, 500);
    assert.equal(res.summary.statesCreated, 0);
    assert.equal(deps.store.rows.length, 25);
    assert.equal(res.reconciliation.drift, false);
  });

  test('production write requires --approve-digest', async () => {
    const { manifestJson } = await selectManifest();
    const deps = baseDeps();
    await assert.rejects(
      () => cli.run({ fromManifest: 'p.json', production: true, confirm: 'PROVISION-STATES', now: NOW, __readFile: () => manifestJson }, deps),
      /approve-digest/,
    );
    assert.equal(deps.store.rows.length, 25);
  });

  test('production write refuses a mismatched --approve-digest', async () => {
    const { manifestJson } = await selectManifest();
    const deps = baseDeps();
    const wrong = 'a'.repeat(64);
    await assert.rejects(
      () => cli.run({ fromManifest: 'p.json', production: true, confirm: 'PROVISION-STATES', approveDigest: wrong, now: NOW, __readFile: () => manifestJson }, deps),
      /does not match/,
    );
    assert.equal(deps.store.rows.length, 25);
  });

  test('refuses a tampered manifest (digest no longer matches content)', async () => {
    const { manifest } = await selectManifest();
    const tampered = JSON.parse(JSON.stringify(manifest));
    tampered.entries[0].organisationId = 'ORG-NEW-9999'; // alter content, stale digest
    const deps = baseDeps();
    await assert.rejects(
      () => cli.run({ fromManifest: 'p.json', __readFile: () => JSON.stringify(tampered) }, deps),
      /digest mismatch|inconsistent ranking/,
    );
  });

  test('refuses invalid JSON, wrong schema, and wrong cohort salt', async () => {
    const deps = baseDeps();
    await assert.rejects(() => cli.run({ fromManifest: 'p.json', __readFile: () => '{not json' }, deps), /not valid JSON/);
    await assert.rejects(() => cli.run({ fromManifest: 'p.json', __readFile: () => JSON.stringify({ schema: 'nope' }) }, deps), /schema/);
    const { manifest } = await selectManifest();
    const wrongSalt = { ...JSON.parse(JSON.stringify(manifest)), cohortSalt: ':cohort:v2' };
    await assert.rejects(() => cli.run({ fromManifest: 'p.json', __readFile: () => JSON.stringify(wrongSalt) }, deps), /cohortSalt/);
  });

  test('DRIFT: refuses when a manifest org has lost eligibility (live selection differs)', async () => {
    const { manifest, manifestJson } = await selectManifest();
    const dropped = manifest.entries[0].organisationId;
    const r = makeResolve();
    const baseResolve = r.resolveOrganisationByDomain;
    const driftResolve = {
      ...r,
      resolveOrganisationByDomain: (d) => (d === `${dropped.toLowerCase()}.example`
        ? { outcome: 'AMBIGUOUS', organisationId: null } // dropped org no longer resolvable
        : baseResolve(d)),
    };
    const deps = baseDeps({ resolve: driftResolve });
    await assert.rejects(
      () => cli.run({ fromManifest: 'p.json', __readFile: () => manifestJson }, deps),
      /drift/,
    );
  });

  test('RETRY after partial write completes ONLY the reviewed cohort — never expands to 160', async () => {
    const { manifest, manifestJson } = await selectManifest();
    const deps = baseDeps();
    // Simulate a partial prior write: the first 60 manifest orgs already have all 5 states.
    const first60 = manifest.entries.slice(0, 60).map((e) => e.organisationId);
    for (const id of first60) for (const t of DNS_TYPES) deps.store.rows.push({ organisationId: id, observationType: t, status: 'observed', evidenceRef: `ev:${id}:${t}` });

    const res = await cli.run({
      fromManifest: 'p.json', production: true, confirm: 'PROVISION-STATES',
      approveDigest: manifest.cohortDigest, now: NOW, __readFile: () => manifestJson,
    }, deps);

    assert.equal(res.summary.statesCreated, 200); // only the remaining 40 orgs × 5
    const newOrgs = new Set(deps.store.rows.filter((rr) => rr.organisationId.startsWith('ORG-NEW-')).map((rr) => rr.organisationId));
    assert.equal(newOrgs.size, 100); // EXACTLY the reviewed 100 — not 160
    const manifestSet = new Set(manifest.entries.map((e) => e.organisationId));
    for (const id of newOrgs) assert.ok(manifestSet.has(id), `${id} must be within the reviewed manifest`);
    assert.equal(deps.store.rows.length, 25 + 60 * 5 + 40 * 5); // 525
  });

  test('idempotent: re-running the production write from the same manifest creates nothing new', async () => {
    const { manifest, manifestJson } = await selectManifest();
    const deps = baseDeps();
    const common = {
      fromManifest: 'p.json', production: true, confirm: 'PROVISION-STATES',
      approveDigest: manifest.cohortDigest, now: NOW, __readFile: () => manifestJson,
    };
    const first = await cli.run(common, deps);
    assert.equal(first.summary.statesCreated, 500);
    const second = await cli.run(common, deps);
    assert.equal(second.summary.statesCreated, 0);
    assert.equal(deps.store.rows.length, 25 + 500);
  });

  test('--from-manifest is mutually exclusive with --cohort-size and --limit', async () => {
    const deps = baseDeps();
    await assert.rejects(() => cli.run({ fromManifest: 'p.json', cohortSize: 10 }, deps), /mutually exclusive/);
    await assert.rejects(() => cli.run({ fromManifest: 'p.json', limit: 10 }, deps), /mutually exclusive/);
  });
});

// WP-2 (TD-03) — Provisioning safety gate: --from-manifest is the SOLE
// production-write path. The legacy no-mode (full-population) and --limit paths
// must refuse to write in production; dry-run of those paths stays available;
// the governed --from-manifest write and the existing --cohort-size production
// refusal are unchanged.
describe('provision CLI production-write safety gate (WP-2 / TD-03)', () => {
  const NOW = '2026-03-10T12:00:00.000Z';

  // baseDeps plus a provisioning-writer SPY, so a refused path can be proven to
  // never invoke the writer. runLegacy/runFromManifest both use
  // deps.provisionObservationStates when supplied.
  function spyDeps(overrides = {}) {
    let calls = 0;
    const deps = baseDeps({
      provisionObservationStates: async () => {
        calls += 1;
        return {
          statesCreated: 0, statesToCreate: 0, eligibleOrganisations: 0,
          consideredOrganisations: 0, organisationsAlreadyComplete: 0, statesExisting: 0,
        };
      },
      ...overrides,
    });
    deps.provisionCalls = () => calls;
    return deps;
  }

  const DIRECTS_TO_MANIFEST = /--from-manifest[\s\S]*--approve-digest|--cohort-size <N> --manifest/;

  test('1+2+5: bare/no-mode --production --confirm is refused, writes nothing, and directs to the manifest workflow', async () => {
    const deps = spyDeps();
    await assert.rejects(
      () => cli.run({ production: true, confirm: 'PROVISION-STATES', now: NOW }, deps),
      (err) => {
        assert.match(err.message, /refusing to write/);
        assert.match(err.message, /--from-manifest/);
        assert.match(err.message, DIRECTS_TO_MANIFEST);
        return true;
      },
    );
    assert.equal(deps.provisionCalls(), 0, 'the provisioning writer must never be invoked on a refused production attempt');
    assert.equal(deps.store.rows.length, 25, 'no observation state may be written on refusal');
  });

  test('3+4: --limit N --production --confirm is refused, writes nothing (same safety message)', async () => {
    const deps = spyDeps();
    await assert.rejects(
      () => cli.run({ limit: 50, production: true, confirm: 'PROVISION-STATES', now: NOW }, deps),
      (err) => {
        assert.match(err.message, /refusing to write/);
        assert.match(err.message, DIRECTS_TO_MANIFEST);
        return true;
      },
    );
    assert.equal(deps.provisionCalls(), 0);
    assert.equal(deps.store.rows.length, 25);
  });

  test('6: bare/no-mode dry-run remains permitted (no --production → legacy dry-run, no write)', async () => {
    const deps = baseDeps();
    const res = await cli.run({ now: NOW }, deps);
    assert.equal(res.mode, 'legacy');
    assert.equal(res.dryRun, true);
    assert.equal(res.summary.statesCreated, 0);
    assert.equal(deps.store.rows.length, 25);
  });

  test('6b: --production WITHOUT --confirm still downgrades to a dry-run (non-writing flow preserved)', async () => {
    const deps = spyDeps();
    const res = await cli.run({ production: true, now: NOW }, deps);
    assert.equal(res.dryRun, true, 'no --confirm ⇒ not a write attempt ⇒ still runs as dry-run');
    assert.equal(deps.store.rows.length, 25);
  });

  test('7: --limit dry-run remains permitted (no --production → legacy dry-run)', async () => {
    const deps = baseDeps();
    const res = await cli.run({ limit: 3, now: NOW }, deps);
    assert.equal(res.mode, 'legacy');
    assert.equal(res.dryRun, true);
    assert.equal(deps.store.rows.length, 25);
  });

  test('8: the governed --from-manifest production write still succeeds (behaviourally unchanged)', async () => {
    const sel = await cli.run({ cohortSize: 100, now: NOW }, baseDeps());
    const manifestJson = JSON.stringify(sel.manifest);
    const deps = baseDeps();
    const res = await cli.run({
      fromManifest: 'p.json', production: true, confirm: 'PROVISION-STATES',
      approveDigest: sel.manifest.cohortDigest, now: NOW, __readFile: () => manifestJson,
    }, deps);
    assert.equal(res.mode, 'from-manifest');
    assert.equal(res.dryRun, false);
    assert.equal(res.summary.statesCreated, 500);
    assert.equal(deps.store.rows.length, 525);
  });

  test('9: existing --cohort-size --production refusal remains intact (writes nothing)', async () => {
    const deps = baseDeps();
    await assert.rejects(
      () => cli.run({ cohortSize: 10, production: true, confirm: 'PROVISION-STATES', now: NOW }, deps),
      /does not write in production|from-manifest/,
    );
    assert.equal(deps.store.rows.length, 25);
  });
});
