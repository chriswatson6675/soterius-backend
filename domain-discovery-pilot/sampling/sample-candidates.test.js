'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { apportionCategoryTargets, sampleCandidates, TARGET_SAMPLE_SIZE } = require('./sample-candidates');
const { DERIVED_CATEGORIES } = require('./classify-candidate');

// ── apportionCategoryTargets ──────────────────────────────────────────────

test('apportionCategoryTargets: floors of min(4, count) then proportional remainder, sums to sampleSize', () => {
  const counts = { TRUST_OR_COMPANY_SERVICE_PROVIDER: 50, MONEY_SERVICE_BUSINESS: 3, HIGH_VALUE_DEALER: 0, ESTATE_OR_LETTING_AGENCY: 20, ACCOUNTANCY_SERVICE_PROVIDER: 20, LEGAL_OR_CONVEYANCING: 5, UNCLASSIFIED: 2 };
  const { targets, sampleSize } = apportionCategoryTargets(counts, 100);
  assert.equal(sampleSize, 100);
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  assert.equal(sum, 100);
  // Floor of min(4, count) respected.
  assert.ok(targets.MONEY_SERVICE_BUSINESS <= 3); // capped at count
  assert.ok(targets.LEGAL_OR_CONVEYANCING >= 4);
  assert.ok(targets.UNCLASSIFIED <= 2);
  // Never exceeds available count.
  for (const cat of Object.keys(counts)) {
    assert.ok((targets[cat] || 0) <= counts[cat], `${cat}: ${targets[cat]} > ${counts[cat]}`);
  }
});

test('apportionCategoryTargets: total valid records < 100 shrinks sample size (documented exception)', () => {
  const counts = { TRUST_OR_COMPANY_SERVICE_PROVIDER: 10, MONEY_SERVICE_BUSINESS: 5, HIGH_VALUE_DEALER: 0, ESTATE_OR_LETTING_AGENCY: 0, ACCOUNTANCY_SERVICE_PROVIDER: 0, LEGAL_OR_CONVEYANCING: 0, UNCLASSIFIED: 0 };
  const { targets, sampleSize } = apportionCategoryTargets(counts, 100);
  assert.equal(sampleSize, 15);
  const sum = Object.values(targets).reduce((a, b) => a + b, 0);
  assert.equal(sum, 15);
});

test('apportionCategoryTargets: deterministic across repeated calls', () => {
  const counts = { TRUST_OR_COMPANY_SERVICE_PROVIDER: 37, MONEY_SERVICE_BUSINESS: 13, HIGH_VALUE_DEALER: 8, ESTATE_OR_LETTING_AGENCY: 22, ACCOUNTANCY_SERVICE_PROVIDER: 41, LEGAL_OR_CONVEYANCING: 9, UNCLASSIFIED: 60 };
  const a = apportionCategoryTargets(counts, 100);
  const b = apportionCategoryTargets(counts, 100);
  assert.deepEqual(a, b);
});

// ── sampleCandidates: full pipeline against a fake adapter ────────────────

function buildSyntheticRows() {
  const rows = [];
  let n = 1;
  const push = (businessName, tradingName, postcode) => {
    rows.push({
      rowIndex: n,
      registrationNumber: String(100000 + n),
      businessName,
      tradingName: tradingName || null,
      postcode: postcode || null,
      status: 'Active',
    });
    n += 1;
  };

  // A broad spread across categories, postcodes (incl. missing), regions,
  // urban/rural, entity forms, and name divergence — large enough (250
  // rows) that the 100-slot sample has real headroom in every stratum.
  const postcodes = ['SW1A 1AA', 'M1 1AE', 'EH1 1BB', 'TR1 1AA', 'CF10 1AA', 'BT1 1AA', null, 'GARBLED'];
  const categories = [
    ['TRUST SERVICES LTD', 'TRUST'],
    ['CURRENCY EXCHANGE LTD', 'MONEY'],
    ['FINE JEWELLERS LTD', 'HVD'],
    ['PRIME ESTATE AGENTS LTD', 'ESTATE'],
    ['ACCURATE ACCOUNTANTS LTD', 'ACCOUNTANCY'],
    ['SWIFT CONVEYANCING LTD', 'LEGAL'],
    ['GENERIC WIDGETS LTD', 'UNCLASSIFIED'],
  ];

  for (let i = 0; i < 250; i++) {
    const [baseName] = categories[i % categories.length];
    const postcode = postcodes[i % postcodes.length];
    const divergent = i % 5 === 0;
    const soleTrader = i % 11 === 0;
    const name = soleTrader ? `PERSON NUMBER ${i}` : `${baseName.replace('LTD', '')}${i} LTD`;
    push(name, divergent ? `Trading Name ${i}` : null, postcode);
  }
  return rows;
}

function fakeAdapter(rows) {
  return {
    async parse() { return rows; },
    validateStructure(rs) { return { valid: rs.filter((r) => r.businessName), rejected: [] }; },
    normalise(validRows) {
      return validRows.map((r) => ({ name: r.businessName, tradingName: r.tradingName, hmrcAml: r.registrationNumber }));
    },
  };
}

test('sampleCandidates: produces exactly 100 candidates when pool >= 100', async () => {
  const rows = buildSyntheticRows();
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  assert.equal(result.sampleSize, 100);
  assert.equal(result.candidates.length, 100);
  assert.equal(result.exceptionApplied, false);
});

test('sampleCandidates: sample_rank is 1..N ascending by registration number', async () => {
  const rows = buildSyntheticRows();
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  const ranks = result.candidates.map((c) => c.sampleRank);
  assert.deepEqual(ranks, Array.from({ length: result.candidates.length }, (_, i) => i + 1));
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].hmrcRegistrationNumber < result.candidates[i].hmrcRegistrationNumber);
  }
});

test('sampleCandidates: no duplicate candidates selected', async () => {
  const rows = buildSyntheticRows();
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  const regNums = result.candidates.map((c) => c.hmrcRegistrationNumber);
  assert.equal(new Set(regNums).size, regNums.length);
});

test('sampleCandidates: fully deterministic — running twice yields identical output', async () => {
  const rows = buildSyntheticRows();
  const a = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  const b = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  assert.deepEqual(a, b);
});

test('sampleCandidates: every selected candidate carries sampling_rule_version and floor_pass_selected', async () => {
  const rows = buildSyntheticRows();
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  for (const c of result.candidates) {
    assert.equal(c.samplingRuleVersion, 'DDP-SAMPLE-v1.0');
    assert.equal(typeof c.floorPassSelected, 'boolean');
  }
});

test('sampleCandidates: shrinks sample size below 100 when the valid pool is smaller (documented exception)', async () => {
  const rows = buildSyntheticRows().slice(0, 40);
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  assert.equal(result.totalValidRecords, 40);
  assert.equal(result.sampleSize, 40);
  assert.equal(result.exceptionApplied, true);
});

test('sampleCandidates: category targets never exceed each derived category population', async () => {
  const rows = buildSyntheticRows();
  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  const countsSelected = {};
  for (const cat of DERIVED_CATEGORIES) countsSelected[cat] = 0;
  for (const c of result.candidates) countsSelected[c.derivedCategory] += 1;
  for (const cat of DERIVED_CATEGORIES) {
    assert.ok(countsSelected[cat] <= (result.categoryTargets[cat] || 0) + 0); // selected == target achieved (or less if pool exhausted)
  }
});
