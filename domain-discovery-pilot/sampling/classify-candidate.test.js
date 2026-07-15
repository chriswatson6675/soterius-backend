'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  derivedCategory, nameAmbiguityClass, nameDivergenceClass, entityFormClass,
  postcodeCompletenessClass, regionClass, urbanRuralClass, classifyCandidate,
} = require('./classify-candidate');

// ── derivedCategory ──────────────────────────────────────────────────────

test('derivedCategory: first-match-wins priority order', () => {
  assert.equal(derivedCategory('ACME TRUST AND COMPANY SECRETARIAL SERVICES LTD'), 'TRUST_OR_COMPANY_SERVICE_PROVIDER');
  assert.equal(derivedCategory('ACME CURRENCY EXCHANGE LTD'), 'MONEY_SERVICE_BUSINESS');
  assert.equal(derivedCategory('ACME JEWELLERS LTD'), 'HIGH_VALUE_DEALER');
  assert.equal(derivedCategory('ACME ESTATE AGENTS LTD'), 'ESTATE_OR_LETTING_AGENCY');
  assert.equal(derivedCategory('ACME ACCOUNTANTS LTD'), 'ACCOUNTANCY_SERVICE_PROVIDER');
  assert.equal(derivedCategory('ACME CONVEYANCING LTD'), 'LEGAL_OR_CONVEYANCING');
  assert.equal(derivedCategory('ACME WIDGETS LTD'), 'UNCLASSIFIED');
});

test('derivedCategory: priority order — trust keyword beats a later-priority keyword', () => {
  // Contains both TRUST (priority 1) and TAX (priority 5, accountancy) — trust wins.
  assert.equal(derivedCategory('ACME TRUST AND TAX LTD'), 'TRUST_OR_COMPANY_SERVICE_PROVIDER');
});

// ── nameAmbiguityClass (exact-fraction boundary cases) ──────────────────────

test('nameAmbiguityClass: HIGHLY_GENERIC at ratio == 0.66 boundary (2/3)', () => {
  // normaliseName drops "LTD" suffix -> tokens: SERVICES, CONSULTING, ACME (3 tokens, 2 generic)
  assert.equal(nameAmbiguityClass('SERVICES CONSULTING ACME LTD'), 'HIGHLY_GENERIC');
});

test('nameAmbiguityClass: MODERATELY_AMBIGUOUS at ratio == 0.33 boundary (1/3)', () => {
  // tokens: SERVICES, ACME, WIDGETS (3 tokens, 1 generic) -> ratio exactly 1/3
  assert.equal(nameAmbiguityClass('SERVICES ACME WIDGETS'), 'MODERATELY_AMBIGUOUS');
});

test('nameAmbiguityClass: DISTINCTIVE below 0.33', () => {
  // tokens: ACME, WIDGETS, FOUR, FIVE (4 tokens, 0 generic)
  assert.equal(nameAmbiguityClass('ACME WIDGETS FOUR FIVE'), 'DISTINCTIVE');
});

test('nameAmbiguityClass: empty/degenerate name is DISTINCTIVE (no generic tokens possible)', () => {
  assert.equal(nameAmbiguityClass(''), 'DISTINCTIVE');
  assert.equal(nameAmbiguityClass(null), 'DISTINCTIVE');
});

// ── nameDivergenceClass ──────────────────────────────────────────────────────

test('nameDivergenceClass: NAME_ALIGNED when tradingName empty', () => {
  assert.equal(nameDivergenceClass('ACME LTD', ''), 'NAME_ALIGNED');
  assert.equal(nameDivergenceClass('ACME LTD', null), 'NAME_ALIGNED');
});

test('nameDivergenceClass: NAME_ALIGNED when trading name normalises identically', () => {
  assert.equal(nameDivergenceClass('ACME LIMITED', 'Acme Ltd'), 'NAME_ALIGNED');
});

test('nameDivergenceClass: NAME_DIVERGENT when trading name normalises differently', () => {
  assert.equal(nameDivergenceClass('ACME LIMITED', 'Bright Widgets'), 'NAME_DIVERGENT');
});

// ── entityFormClass ───────────────────────────────────────────────────────────

test('entityFormClass: CORPORATE_FORM for LIMITED/LTD/LLP/PLC/CIC suffixes', () => {
  assert.equal(entityFormClass('ACME LIMITED', null), 'CORPORATE_FORM');
  assert.equal(entityFormClass('ACME LTD', null), 'CORPORATE_FORM');
  assert.equal(entityFormClass('ACME LLP', null), 'CORPORATE_FORM');
  assert.equal(entityFormClass('ACME PLC', null), 'CORPORATE_FORM');
  assert.equal(entityFormClass('ACME CIC', null), 'CORPORATE_FORM');
});

test('entityFormClass: SOLE_TRADER_OR_OTHER for T/A or TRADING AS', () => {
  assert.equal(entityFormClass('JOHN SMITH T/A ACME REPAIRS', null), 'SOLE_TRADER_OR_OTHER');
  assert.equal(entityFormClass('JOHN SMITH TRADING AS ACME REPAIRS', null), 'SOLE_TRADER_OR_OTHER');
});

test('entityFormClass: SOLE_TRADER_OR_OTHER for bounded personal-name shape (2-3 tokens, no suffix)', () => {
  assert.equal(entityFormClass('JOHN SMITH', null), 'SOLE_TRADER_OR_OTHER');
  assert.equal(entityFormClass('JOHN ROBERT SMITH', null), 'SOLE_TRADER_OR_OTHER');
  assert.equal(entityFormClass('JOHN SMITH', 'JOHN SMITH'), 'SOLE_TRADER_OR_OTHER');
});

test('entityFormClass: FORM_INDETERMINATE for a >3-token name with no suffix and no T/A', () => {
  assert.equal(entityFormClass('ACME WIDGETS AND GADGETS COMPANY', null), 'FORM_INDETERMINATE');
});

test('entityFormClass: personal-name shape rejected when tradingName differs from businessName', () => {
  assert.equal(entityFormClass('JOHN SMITH', 'ACME WIDGETS'), 'FORM_INDETERMINATE');
});

// ── postcodeCompletenessClass ─────────────────────────────────────────────────

test('postcodeCompletenessClass: COMPLETE for a full valid UK postcode', () => {
  assert.equal(postcodeCompletenessClass('SW1A 1AA'), 'POSTCODE_COMPLETE');
  assert.equal(postcodeCompletenessClass('EH11BB'), 'POSTCODE_COMPLETE');
});

test('postcodeCompletenessClass: PARTIAL for a non-empty non-matching value', () => {
  assert.equal(postcodeCompletenessClass('SW1A'), 'POSTCODE_PARTIAL');
  assert.equal(postcodeCompletenessClass('NOTAPOSTCODE'), 'POSTCODE_PARTIAL');
});

test('postcodeCompletenessClass: MISSING for empty/null', () => {
  assert.equal(postcodeCompletenessClass(''), 'POSTCODE_MISSING');
  assert.equal(postcodeCompletenessClass(null), 'POSTCODE_MISSING');
  assert.equal(postcodeCompletenessClass(undefined), 'POSTCODE_MISSING');
});

// ── regionClass / urbanRuralClass ─────────────────────────────────────────────

test('regionClass: maps known prefixes to their documented region', () => {
  assert.equal(regionClass('EH1 1AA'), 'SCOTLAND');
  assert.equal(regionClass('CF10 1AA'), 'WALES');
  assert.equal(regionClass('BT1 1AA'), 'NORTHERN_IRELAND');
  assert.equal(regionClass('SW1A 1AA'), 'LONDON');
  assert.equal(regionClass('M1 1AA'), 'NORTH_ENGLAND');
  assert.equal(regionClass('B1 1AA'), 'MIDLANDS');
  assert.equal(regionClass('LS1 1AA'), 'NORTH_ENGLAND');
});

test('regionClass: REGION_UNKNOWN for missing/unrecognised postcode', () => {
  assert.equal(regionClass(''), 'REGION_UNKNOWN');
  assert.equal(regionClass('ZZ1 1AA'), 'REGION_UNKNOWN');
});

test('urbanRuralClass: URBAN/RURAL/MIXED_OR_UNVERIFIED', () => {
  assert.equal(urbanRuralClass('M1 1AA'), 'URBAN');
  assert.equal(urbanRuralClass('EH1 1AA'), 'URBAN');
  assert.equal(urbanRuralClass('TR1 1AA'), 'RURAL');
  assert.equal(urbanRuralClass('IV1 1AA'), 'RURAL');
  assert.equal(urbanRuralClass('ZZ1 1AA'), 'MIXED_OR_UNVERIFIED');
  assert.equal(urbanRuralClass(''), 'MIXED_OR_UNVERIFIED');
});

// ── classifyCandidate aggregate + determinism ────────────────────────────────

test('classifyCandidate: aggregates all 7 dimensions deterministically', () => {
  const record = { businessName: 'JOHN SMITH T/A ACME TRUST SERVICES', tradingName: 'Acme Trust Services', postcode: 'EH1 1AA' };
  const a = classifyCandidate(record);
  const b = classifyCandidate(record);
  assert.deepEqual(a, b);
  assert.equal(a.derivedCategory, 'TRUST_OR_COMPANY_SERVICE_PROVIDER');
  assert.equal(a.nameDivergenceClass, 'NAME_DIVERGENT');
  assert.equal(a.regionClass, 'SCOTLAND');
  assert.equal(a.urbanRuralClass, 'URBAN');
  assert.equal(a.samplingRuleVersion, 'DDP-SAMPLE-v1.0');
});
