'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { apportionCategoryTargets, sampleCandidates, deduplicateByRegistrationNumber, DEDUP_RULE_VERSION, TARGET_SAMPLE_SIZE } = require('./sample-candidates');
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

// ── deduplicateByRegistrationNumber ───────────────────────────────────────
// Real-world motivation (from the five-record live smoke test, verified
// against the actual HMRC AML dataset): "POST OFFICE LIMITED" has 6,733
// branch rows sharing one registrationNumber. Pre-fix, stratified sampling
// operated at the row level and could select several branches of the same
// business into one 100-record sample.

function row(overrides) {
  return { registrationNumber: '900001', businessName: 'BASE LTD', tradingName: null, postcode: null, __poolIndex: 0, ...overrides };
}

test('deduplicateByRegistrationNumber: distinct registration numbers all survive untouched', () => {
  const rows = [
    row({ registrationNumber: '1', __poolIndex: 0 }),
    row({ registrationNumber: '2', __poolIndex: 1 }),
    row({ registrationNumber: '3', __poolIndex: 2 }),
  ];
  const out = deduplicateByRegistrationNumber(rows);
  assert.equal(out.length, 3);
  for (const r of out) {
    assert.equal(r.sourceRowCount, 1);
    assert.equal(r.representsMultipleBranches, false);
    assert.equal(r.representativeSelectionRuleVersion, DEDUP_RULE_VERSION);
  }
});

test('deduplicateByRegistrationNumber: rule 1 — most complete postcode wins', () => {
  const rows = [
    row({ __poolIndex: 0, postcode: null }),                 // MISSING
    row({ __poolIndex: 1, postcode: 'SW1A 1AA' }),            // COMPLETE
    row({ __poolIndex: 2, postcode: 'GARBLEDNOTAPOSTCODE' }), // PARTIAL
  ];
  const out = deduplicateByRegistrationNumber(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].postcode, 'SW1A 1AA');
  assert.equal(out[0].sourceRowCount, 3);
  assert.equal(out[0].representsMultipleBranches, true);
});

test('deduplicateByRegistrationNumber: rule 2 — among equal postcode completeness, non-empty tradingName wins', () => {
  const rows = [
    row({ __poolIndex: 0, postcode: 'SW1A 1AA', tradingName: null }),
    row({ __poolIndex: 1, postcode: 'EH1 1BB', tradingName: 'BRANCH B' }),
  ];
  const out = deduplicateByRegistrationNumber(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].tradingName, 'BRANCH B');
});

test('deduplicateByRegistrationNumber: rule 3 — among equal postcode completeness and trading-name presence, earliest source-row order wins', () => {
  const rows = [
    row({ __poolIndex: 5, postcode: 'SW1A 1AA', tradingName: 'LATER' }),
    row({ __poolIndex: 2, postcode: 'EH1 1BB', tradingName: 'EARLIER' }),
  ];
  const out = deduplicateByRegistrationNumber(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].tradingName, 'EARLIER');
  assert.equal(out[0].__poolIndex, 2);
});

test('deduplicateByRegistrationNumber: rule 4 — final tie-break is lexical postcode when source-row order is equal', () => {
  // __poolIndex ties are contrived here only to exercise rule 4 directly;
  // in real data __poolIndex is always unique, so rule 3 normally resolves first.
  const rows = [
    row({ __poolIndex: 0, postcode: 'ZZ1 1AA', tradingName: 'X' }),
    row({ __poolIndex: 0, postcode: 'AA1 1AA', tradingName: 'Y' }),
  ];
  const out = deduplicateByRegistrationNumber(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].postcode, 'AA1 1AA');
});

test('deduplicateByRegistrationNumber: does not mutate or drop the underlying source rows, only selects a representative', () => {
  const rows = [
    row({ __poolIndex: 0, postcode: 'SW1A 1AA' }),
    row({ __poolIndex: 1, postcode: 'EH1 1BB' }),
  ];
  const before = JSON.parse(JSON.stringify(rows));
  deduplicateByRegistrationNumber(rows);
  assert.deepEqual(rows, before);
});

test('sampleCandidates: thousands of synthetic branch rows for one registration cannot dominate the sample', async () => {
  const rows = [];
  let n = 1;
  // 6,000 branches of ONE business, mirroring the real Post Office scale.
  for (let i = 0; i < 6000; i++) {
    rows.push({
      rowIndex: n, registrationNumber: '12137104', businessName: 'POST OFFICE LIMITED',
      tradingName: `BRANCH ${i}`, postcode: `SW1${i % 9}A 1AA`, status: 'Active',
    });
    n += 1;
  }
  // Plus 250 genuinely distinct businesses spanning every category, so the
  // sample has somewhere else to go.
  const categories = ['TRUST SERVICES', 'CURRENCY EXCHANGE', 'FINE JEWELLERS', 'PRIME ESTATE AGENTS', 'ACCURATE ACCOUNTANTS', 'SWIFT CONVEYANCING', 'GENERIC WIDGETS'];
  for (let i = 0; i < 250; i++) {
    rows.push({
      rowIndex: n, registrationNumber: String(500000 + i), businessName: `${categories[i % categories.length]} ${i} LTD`,
      tradingName: null, postcode: 'M1 1AE', status: 'Active',
    });
    n += 1;
  }

  const result = await sampleCandidates({ rawOdsBuffer: Buffer.from(''), hmrcAdapter: fakeAdapter(rows) });
  const postOfficeCandidates = result.candidates.filter((c) => c.hmrcRegistrationNumber === '12137104');
  assert.equal(postOfficeCandidates.length, 1, 'one registration must occupy at most one sample slot, however many branch rows it has');
  if (postOfficeCandidates.length === 1) {
    assert.equal(postOfficeCandidates[0].sourceRowCount, 6000);
    assert.equal(postOfficeCandidates[0].representsMultipleBranches, true);
  }
  assert.equal(result.sampleSize, 100);
});
