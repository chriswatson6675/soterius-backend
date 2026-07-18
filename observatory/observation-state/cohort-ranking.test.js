'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { cohortRank } = require('./shard-assignment');
const {
  selectCohortByRank, buildCohortManifest, manifestToCsv, CohortSelectionError,
} = require('./cohort-ranking');

// Deterministic synthetic eligible population — a pure fixture, no DB.
function makeEligible(n, prefix = 'ORG-FIX-') {
  return Array.from({ length: n }, (_, i) => {
    const id = `${prefix}${String(i).padStart(5, '0')}`;
    return { organisationId: id, domain: `${id.toLowerCase()}.example`, organisationName: `Fixture ${i}` };
  });
}

// Reference ordering computed independently the way the selector must: ascending
// unsigned cohort rank, tie-broken by ascending organisationId.
function referenceOrder(orgs) {
  return [...orgs]
    .map((o) => ({ id: o.organisationId, rank: cohortRank(o.organisationId) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
    .map((x) => x.id);
}

function shuffleDeterministic(arr) {
  // Reverse + interleave — a fixed non-identity permutation (no Math.random).
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    out.push(arr[(i * 7 + 3) % arr.length]);
  }
  // Dedup preserving first occurrence so it stays a permutation of unique ids.
  const seen = new Set();
  return out.filter((o) => (seen.has(o.organisationId) ? false : seen.add(o.organisationId)));
}

describe('selectCohortByRank — validation', () => {
  const eligible = makeEligible(10);
  for (const bad of [0, -1, 3.5, NaN, '5', null, undefined]) {
    test(`rejects invalid size ${JSON.stringify(bad)}`, () => {
      assert.throws(() => selectCohortByRank(eligible, { size: bad }), CohortSelectionError);
    });
  }
  test('rejects a non-array eligible population', () => {
    assert.throws(() => selectCohortByRank('nope', { size: 1 }), CohortSelectionError);
  });
});

describe('selectCohortByRank — selection behaviour (group B)', () => {
  test('excludes already-provisioned organisations BEFORE slicing', () => {
    const eligible = makeEligible(20);
    const ranked = referenceOrder(eligible);
    const provision = ranked.slice(0, 3); // provision the 3 lowest-ranked
    const r = selectCohortByRank(eligible, { size: 5, alreadyProvisionedOrganisationIds: provision });
    // None of the provisioned appear, and we still get a full 5 NEW.
    for (const id of provision) assert.ok(!r.selected.some((s) => s.organisationId === id));
    assert.equal(r.selectedCount, 5);
    assert.deepEqual(r.selected.map((s) => s.organisationId), ranked.filter((id) => !provision.includes(id)).slice(0, 5));
  });

  test('returns exactly N new organisations when enough remain', () => {
    const eligible = makeEligible(500);
    const r = selectCohortByRank(eligible, { size: 100, alreadyProvisionedOrganisationIds: [] });
    assert.equal(r.selectedCount, 100);
    assert.equal(r.sufficient, true);
  });

  test('never returns duplicates even if the input repeats an organisation', () => {
    const eligible = makeEligible(10);
    const withDupes = [...eligible, eligible[2], eligible[5]];
    const r = selectCohortByRank(withDupes, { size: 10, alreadyProvisionedOrganisationIds: [] });
    const ids = r.selected.map((s) => s.organisationId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(r.selectedCount, 10);
  });

  test('returns ALL remaining when fewer than N unprovisioned exist', () => {
    const eligible = makeEligible(10);
    const provisioned = referenceOrder(eligible).slice(0, 4);
    const r = selectCohortByRank(eligible, { size: 100, alreadyProvisionedOrganisationIds: provisioned });
    assert.equal(r.selectedCount, 6);
    assert.equal(r.sufficient, false);
    assert.equal(r.eligibleUnprovisionedCount, 6);
  });

  test('repeated selection over identical inputs produces identical ordering', () => {
    const eligible = makeEligible(300);
    const a = selectCohortByRank(eligible, { size: 100 });
    const b = selectCohortByRank(eligible, { size: 100 });
    assert.deepEqual(a.selected, b.selected);
  });

  test('100-selection is exactly the first 100 of the full ranked eligible-unprovisioned order', () => {
    const eligible = makeEligible(400);
    const r = selectCohortByRank(eligible, { size: 100 });
    assert.deepEqual(r.selected.map((s) => s.organisationId), referenceOrder(eligible).slice(0, 100));
  });

  test('emitted order obeys ascending rank then ascending id (tie-break rule applied)', () => {
    const eligible = makeEligible(250);
    const r = selectCohortByRank(eligible, { size: 250 });
    assert.deepEqual(r.selected.map((s) => s.organisationId), referenceOrder(eligible));
    for (let i = 1; i < r.selected.length; i += 1) {
      const prev = r.selected[i - 1];
      const cur = r.selected[i];
      assert.ok(prev.rank < cur.rank || (prev.rank === cur.rank && prev.organisationId < cur.organisationId));
    }
  });
});

describe('selectCohortByRank — independence from input order (group D)', () => {
  test('different authority/enumeration ordering does not affect the selected cohort', () => {
    const eligible = makeEligible(300);
    const shuffled = shuffleDeterministic(eligible);
    assert.notDeepEqual(shuffled.map((o) => o.organisationId), eligible.map((o) => o.organisationId)); // really reordered
    const a = selectCohortByRank(eligible, { size: 100 });
    const b = selectCohortByRank(shuffled, { size: 100 });
    assert.deepEqual(a.selected.map((s) => s.organisationId), b.selected.map((s) => s.organisationId));
  });
});

describe('selectCohortByRank — cumulative rollout (100 → 1,000)', () => {
  test('100 then next-900 (after marking the 100 provisioned) equals a single 1,000 from baseline', () => {
    // Baseline: 1,200 eligible + 5 already-provisioned pilots.
    const pilots = ['ORG-111BB396F405', 'ORG-022966B7A563', 'ORG-008B5C6DDCA9', 'ORG-00A735D8BF71', 'ORG-FFE3D2E76F65'];
    const eligible = [...pilots.map((id) => ({ organisationId: id, domain: `${id}.example` })), ...makeEligible(1200)];

    // Single-shot 1,000 from the original baseline (pilots excluded).
    const single = selectCohortByRank(eligible, { size: 1000, alreadyProvisionedOrganisationIds: pilots });

    // Split: Phase 1A picks 100, then Phase 1B picks 900 after those 100 join
    // the provisioned set (alongside the pilots).
    const phase1a = selectCohortByRank(eligible, { size: 100, alreadyProvisionedOrganisationIds: pilots });
    const afterPhase1a = [...pilots, ...phase1a.selected.map((s) => s.organisationId)];
    const phase1b = selectCohortByRank(eligible, { size: 900, alreadyProvisionedOrganisationIds: afterPhase1a });

    const cumulative = [...phase1a.selected.map((s) => s.organisationId), ...phase1b.selected.map((s) => s.organisationId)];

    assert.equal(single.selectedCount, 1000);
    assert.equal(cumulative.length, 1000);
    assert.deepEqual(cumulative, single.selected.map((s) => s.organisationId));
    // No overlap between the two phases and no pilot anywhere.
    assert.equal(new Set(cumulative).size, 1000);
    for (const id of pilots) assert.ok(!cumulative.includes(id));
    const overlap = phase1a.selected.map((s) => s.organisationId).filter((id) => phase1b.selected.some((s) => s.organisationId === id));
    assert.equal(overlap.length, 0);
  });
});

describe('buildCohortManifest / manifestToCsv — deterministic, credential-free', () => {
  test('manifest is byte-equivalent across repeated runs (no timestamp)', () => {
    const eligible = makeEligible(120);
    const m1 = JSON.stringify(buildCohortManifest(selectCohortByRank(eligible, { size: 100 })));
    const m2 = JSON.stringify(buildCohortManifest(selectCohortByRank(eligible, { size: 100 })));
    assert.equal(m1, m2);
  });

  test('manifest carries rank/position/id/name/domain/eligibility and nothing secret', () => {
    const eligible = makeEligible(10);
    const manifest = buildCohortManifest(selectCohortByRank(eligible, { size: 3 }));
    assert.equal(manifest.schema, 'obs-103-cohort-manifest/v1');
    assert.equal(manifest.entries.length, 3);
    const keys = Object.keys(manifest.entries[0]).sort();
    assert.deepEqual(keys, ['domain', 'eligibilityBasis', 'organisationId', 'organisationName', 'position', 'rank']);
    const serialized = JSON.stringify(manifest).toLowerCase();
    for (const secret of ['password', 'service_role', 'apikey', 'api_key', 'secret', 'token', 'supabase_url']) {
      assert.ok(!serialized.includes(secret), `manifest must not contain "${secret}"`);
    }
  });

  test('CSV is deterministic with a fixed header and one row per selected org', () => {
    const eligible = makeEligible(5);
    const csv = manifestToCsv(buildCohortManifest(selectCohortByRank(eligible, { size: 3 })));
    const lines = csv.trimEnd().split('\n');
    assert.equal(lines[0], 'position,rank,organisationId,organisationName,domain,eligibilityBasis');
    assert.equal(lines.length, 4); // header + 3
  });
});
