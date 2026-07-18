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

// ---- OBS-103 BLOCKER 2 + CSV injection: manifest identity, validation, reconcile ----
const cr = require('./cohort-ranking');

describe('cohort manifest identity + validation', () => {
  test('buildCohortManifest embeds a deterministic 64-hex sha256 digest', () => {
    const sel = selectCohortByRank(makeEligible(120), { size: 100 });
    const m1 = buildCohortManifest(sel);
    const m2 = buildCohortManifest(selectCohortByRank(makeEligible(120), { size: 100 }));
    assert.match(m1.cohortDigest, /^[0-9a-f]{64}$/);
    assert.equal(m1.cohortDigest, m2.cohortDigest); // deterministic
  });

  test('computeCohortDigest changes when any entry changes', () => {
    const sel = selectCohortByRank(makeEligible(50), { size: 20 });
    const m = buildCohortManifest(sel);
    const tampered = JSON.parse(JSON.stringify(m));
    tampered.entries[0].organisationId = 'ORG-DIFFERENT';
    const d = cr.computeCohortDigest({ cohortSalt: tampered.cohortSalt, requestedSize: tampered.requestedSize, entries: tampered.entries });
    assert.notEqual(d, m.cohortDigest);
  });

  test('validateManifest accepts a good manifest and rejects malformed ones', () => {
    const good = buildCohortManifest(selectCohortByRank(makeEligible(30), { size: 10 }));
    assert.doesNotThrow(() => cr.validateManifest(good));
    assert.throws(() => cr.validateManifest(null), cr.ManifestError);
    assert.throws(() => cr.validateManifest({ ...good, schema: 'x' }), /schema/);
    assert.throws(() => cr.validateManifest({ ...good, cohortSalt: ':cohort:v2' }), /cohortSalt/);
    assert.throws(() => cr.validateManifest({ ...good, requestedSize: 0 }), /requestedSize/);
    assert.throws(() => cr.validateManifest({ ...good, cohortDigest: 'nothex' }), /cohortDigest/);
    // Duplicate id (kept otherwise well-formed so it reaches the duplicate check).
    const dupe = JSON.parse(JSON.stringify(good));
    dupe.entries[1].organisationId = dupe.entries[0].organisationId;
    assert.throws(() => cr.validateManifest(dupe), /duplicate/);
  });

  test('validateManifest rejects internally-inconsistent manifests even with a valid digest', () => {
    const good = () => buildCohortManifest(selectCohortByRank(makeEligible(50), { size: 10 }));

    // entries.length must equal selectedCount
    const lenMismatch = good();
    lenMismatch.entries.pop();
    assert.throws(() => cr.validateManifest(lenMismatch), /entries\.length .* selectedCount/);

    // sufficient === true ⇒ entries.length === requestedSize
    const suffMismatch = good();
    suffMismatch.selectedCount = 9;
    suffMismatch.entries.pop();
    assert.throws(() => cr.validateManifest(suffMismatch), /sufficient but selectedCount/);

    // selectedCount cannot exceed requestedSize
    const tooMany = good();
    tooMany.requestedSize = 5;
    assert.throws(() => cr.validateManifest(tooMany), /exceeds requestedSize/);

    // not-sufficient must mean selectedCount < requestedSize
    const badNotSuff = good();
    badNotSuff.sufficient = false;
    assert.throws(() => cr.validateManifest(badNotSuff), /not-sufficient but selectedCount/);

    // positions must be contiguous from 1, unique and ordered
    const gapPos = good();
    gapPos.entries[3].position = 99;
    assert.throws(() => cr.validateManifest(gapPos), /position 99, expected 4/);

    const swappedPos = good();
    [swappedPos.entries[0].position, swappedPos.entries[1].position] = [swappedPos.entries[1].position, swappedPos.entries[0].position];
    assert.throws(() => cr.validateManifest(swappedPos), /position/);

    // ranks must be non-decreasing with position
    const unordered = good();
    unordered.entries[5].rank = unordered.entries[0].rank - 1;
    assert.throws(() => cr.validateManifest(unordered), /lower than the previous entry|position/);

    // sufficient must be a boolean; selectedCount a non-negative integer
    assert.throws(() => cr.validateManifest({ ...good(), sufficient: 'yes' }), /sufficient must be a boolean/);
    assert.throws(() => cr.validateManifest({ ...good(), selectedCount: -1 }), /selectedCount must be a non-negative/);
  });

  test('validateManifest accepts a legitimately not-sufficient (fewer-than-N) manifest', () => {
    // 6 eligible-unprovisioned, requesting 100 → 6 selected, sufficient false.
    const m = buildCohortManifest(selectCohortByRank(makeEligible(6), { size: 100 }));
    assert.equal(m.sufficient, false);
    assert.equal(m.selectedCount, 6);
    assert.doesNotThrow(() => cr.validateManifest(m));
  });

  test('verifyManifestIdentity rejects a tampered digest and an inconsistent rank', () => {
    const good = buildCohortManifest(selectCohortByRank(makeEligible(30), { size: 10 }));
    assert.doesNotThrow(() => cr.verifyManifestIdentity(good));
    const tamperedDigest = { ...good, cohortDigest: 'f'.repeat(64) };
    assert.throws(() => cr.verifyManifestIdentity(tamperedDigest), /digest mismatch/);
    // Alter a rank but re-digest so the digest check passes → rank check must catch it.
    const badRank = JSON.parse(JSON.stringify(good));
    badRank.entries[0].rank += 1;
    badRank.cohortDigest = cr.computeCohortDigest({ cohortSalt: badRank.cohortSalt, requestedSize: badRank.requestedSize, entries: badRank.entries });
    assert.throws(() => cr.verifyManifestIdentity(badRank), /inconsistent ranking/);
  });
});

describe('reconcileManifestAgainstLive', () => {
  test('no drift for a fresh run and for a partial-write retry', () => {
    const eligible = makeEligible(300);
    const manifest = buildCohortManifest(selectCohortByRank(eligible, { size: 100 }));
    const fresh = cr.reconcileManifestAgainstLive(manifest, eligible, []);
    assert.equal(fresh.drift, false);
    assert.equal(fresh.targetOrgIds.length, 100);
    // Partial: 60 manifest orgs already provisioned → still no drift, same target.
    const provisioned = manifest.entries.slice(0, 60).map((e) => e.organisationId);
    const retry = cr.reconcileManifestAgainstLive(manifest, eligible, provisioned);
    assert.equal(retry.drift, false);
    assert.deepEqual(retry.targetOrgIds, manifest.entries.map((e) => e.organisationId));
  });

  test('DRIFT when a manifest org has dropped out of eligibility', () => {
    const eligible = makeEligible(300);
    const manifest = buildCohortManifest(selectCohortByRank(eligible, { size: 100 }));
    const dropped = manifest.entries[0].organisationId;
    const shrunk = eligible.filter((o) => o.organisationId !== dropped);
    const r = cr.reconcileManifestAgainstLive(manifest, shrunk, []);
    assert.equal(r.drift, true);
    assert.match(r.driftReason, /no longer in the deterministic top-100/);
  });

  test('DRIFT when a lower-ranked eligible org would now displace the manifest', () => {
    const small = makeEligible(150);
    const manifest = buildCohortManifest(selectCohortByRank(small, { size: 100 }));
    const larger = makeEligible(300); // superset with 150 extra orgs, some ranking lower
    const r = cr.reconcileManifestAgainstLive(manifest, larger, []);
    assert.equal(r.drift, true);
  });
});

describe('manifestToCsv — spreadsheet formula-injection neutralised', () => {
  test('cells beginning with = + - @ are prefixed so a spreadsheet treats them as text', () => {
    const manifest = {
      entries: [
        { position: 1, rank: 1, organisationId: 'ORG-X', organisationName: '=SUM(A1:A9)', domain: '-evil.example', eligibilityBasis: '@cmd' },
      ],
    };
    const csv = cr.manifestToCsv(manifest);
    assert.ok(csv.includes("'=SUM(A1:A9)"), 'formula name neutralised');
    assert.ok(csv.includes("'-evil.example"), 'leading-dash domain neutralised');
    assert.ok(csv.includes("'@cmd"), 'leading-at neutralised');
  });

  test('neutralises when the first non-whitespace/control character is a formula char', () => {
    const csvFor = (name) => cr.manifestToCsv({
      entries: [{ position: 1, rank: 1, organisationId: 'ORG-X', organisationName: name, domain: 'd.example', eligibilityBasis: 'b' }],
    });
    // Leading spaces / tabs / CR / LF before a formula char → still neutralised.
    assert.ok(csvFor(' =SUM(1)').includes("' =SUM(1)"), 'leading space');
    assert.ok(csvFor('  +2').includes("'  +2"), 'leading spaces + plus');
    assert.ok(csvFor('\t=A1').includes("'\t=A1"), 'leading tab');
    assert.ok(csvFor('\r=A1').includes("'\r=A1"), 'leading CR');
    assert.ok(csvFor('\n=A1').includes("'\n=A1"), 'leading LF');
    assert.ok(csvFor('-2+3').includes("'-2+3"), 'leading dash');
    assert.ok(csvFor('@x').includes("'@x"), 'leading at');
  });

  test('does NOT alter ordinary safe values', () => {
    const csvFor = (name) => cr.manifestToCsv({
      entries: [{ position: 1, rank: 1, organisationId: 'ORG-X', organisationName: name, domain: 'org-x.example', eligibilityBasis: 'b' }],
    });
    for (const safe of ['Safe Ltd', 'Acme & Co', 'org_123', 'A. B. Solicitors']) {
      const csv = csvFor(safe);
      assert.ok(csv.includes(safe), `${safe} present`);
      assert.ok(!csv.includes(`'${safe}`), `${safe} not prefixed`);
    }
    // Standard CSV escaping is unchanged for commas/quotes.
    const csvComma = csvFor('Smith, Jones & Co');
    assert.ok(csvComma.includes('"Smith, Jones & Co"'), 'comma value quoted');
  });
});
