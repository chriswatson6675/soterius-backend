'use strict';

// classify-candidate.js — pure classification functions for the Domain
// Discovery Pilot's stratified sampler (Step 1 of the approved pilot spec).
// No I/O, no randomness, no wall-clock reads. Every function here is a
// deterministic function of its inputs only.
//
// These functions classify a single HMRC AML candidate record (shape:
// { registrationNumber, businessName, tradingName, postcode }) along seven
// dimensions used to build a stratified sample. They intentionally read only
// the fields the HMRC adapter actually surfaces (see
// backend/pae/adapters/hmrc-aml/index.js) — there is no AML sector flag
// available to this pilot, so "derived category" is a name-text proxy, not a
// read of the real sector columns.

const { normaliseName } = require('../../authority/lib/normalise');

const SAMPLING_RULE_VERSION = 'DDP-SAMPLE-v1.0';

// ── 1. Derived category (name-text proxy, first-match-wins) ────────────────

const DERIVED_CATEGORY_RULES = [
  { category: 'TRUST_OR_COMPANY_SERVICE_PROVIDER', keywords: ['TRUST', 'COMPANY SECRETAR', 'FORMATION', 'NOMINEE'] },
  { category: 'MONEY_SERVICE_BUSINESS', keywords: ['MONEY', 'CURRENCY', 'EXCHANGE', 'REMITTANCE', 'BUREAU DE CHANGE'] },
  { category: 'HIGH_VALUE_DEALER', keywords: ['JEWELLER', 'BULLION', 'ANTIQUE', 'ART DEALER'] },
  { category: 'ESTATE_OR_LETTING_AGENCY', keywords: ['ESTATE AGEN', 'LETTING', 'PROPERTY MANAGEMENT'] },
  { category: 'ACCOUNTANCY_SERVICE_PROVIDER', keywords: ['ACCOUNTAN', 'BOOKKEEP', 'TAX', 'AUDIT'] },
  { category: 'LEGAL_OR_CONVEYANCING', keywords: ['CONVEYANC', 'WILL WRIT', 'PROBATE'] },
];

// Exposed so downstream steps (extract-evidence.js's category-consistency
// check) can reuse the SAME keyword list used here in Step 1, per spec —
// never a second, independently-maintained copy.
const DERIVED_CATEGORY_KEYWORDS = Object.freeze(
  Object.fromEntries(DERIVED_CATEGORY_RULES.map((r) => [r.category, r.keywords])),
);

const DERIVED_CATEGORIES = Object.freeze([
  ...DERIVED_CATEGORY_RULES.map((r) => r.category),
  'UNCLASSIFIED',
]);

/** categoryKeywords(category) -> the fixed keyword list for that derived category, or []. */
function categoryKeywords(category) {
  return DERIVED_CATEGORY_KEYWORDS[category] || [];
}

function derivedCategory(businessName) {
  const upper = String(businessName || '').toUpperCase();
  for (const rule of DERIVED_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => upper.includes(kw))) return rule.category;
  }
  return 'UNCLASSIFIED';
}

// ── 2. Name ambiguity (generic-token ratio) ─────────────────────────────────

const GENERIC_TOKEN_STOPLIST = new Set([
  'SERVICES', 'CONSULTING', 'ASSOCIATES', 'PARTNERS', 'GROUP', 'SOLUTIONS',
  'MANAGEMENT', 'ENTERPRISES', 'SMITH', 'JONES', 'BROWN', 'TAYLOR', 'WILSON',
  'DAVIES', 'EVANS', 'THOMAS', 'ROBERTS', 'JOHNSON', 'WALKER', 'WRIGHT',
]);

/**
 * Exact fraction comparison against the 0.66/0.33 thresholds — no floating
 * point division is compared to a rounded threshold; instead
 * numerator*3 vs denominator*2 (>= 0.66..) and numerator*3 vs denominator
 * (>= 0.33..) are compared as integers.
 */
function nameAmbiguityClass(businessName) {
  const normalised = normaliseName(businessName);
  const tokens = normalised ? normalised.split(' ').filter(Boolean) : [];
  const total = tokens.length;
  if (total === 0) return 'DISTINCTIVE';
  const genericCount = tokens.filter((t) => GENERIC_TOKEN_STOPLIST.has(t)).length;

  // ratio >= 0.66  <=>  genericCount / total >= 2/3  <=>  genericCount*3 >= total*2
  if (genericCount * 3 >= total * 2) return 'HIGHLY_GENERIC';
  // ratio >= 0.33  <=>  genericCount / total >= 1/3  <=>  genericCount*3 >= total
  if (genericCount * 3 >= total) return 'MODERATELY_AMBIGUOUS';
  return 'DISTINCTIVE';
}

// ── 3. Name divergence ───────────────────────────────────────────────────────

function nameDivergenceClass(businessName, tradingName) {
  const trading = (tradingName || '').trim();
  if (!trading) return 'NAME_ALIGNED';
  return normaliseName(trading) !== normaliseName(businessName) ? 'NAME_DIVERGENT' : 'NAME_ALIGNED';
}

// ── 4/6. Entity-form proxy (shared signal) ──────────────────────────────────

const CORPORATE_SUFFIX_RE = /\b(LIMITED|LTD|LLP|PLC|CIC|COMMUNITY INTEREST COMPANY)\.?$/i;
const TRADING_AS_RE = /\bT\/A\b|\bTRADING AS\b/i;

// A "capitalised token" accepts either natural case (Smith) or all-caps
// (SMITH) — the HMRC register export is observed to store names in upper
// case, so a strict natural-case test would never match anything real.
const CAPITALISED_TOKEN_RE = /^[A-Z][A-Za-z''-]*$/;

function looksLikePersonalNameShape(businessName, tradingName) {
  const raw = String(businessName || '').trim();
  if (!raw || CORPORATE_SUFFIX_RE.test(raw)) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 3) return false;
  if (!tokens.every((t) => CAPITALISED_TOKEN_RE.test(t))) return false;
  const trading = (tradingName || '').trim();
  if (trading && trading.toUpperCase() !== raw.toUpperCase()) return false;
  return true;
}

function entityFormClass(businessName, tradingName) {
  const raw = String(businessName || '').trim();
  if (CORPORATE_SUFFIX_RE.test(raw)) return 'CORPORATE_FORM';
  if (TRADING_AS_RE.test(raw)) return 'SOLE_TRADER_OR_OTHER';
  if (looksLikePersonalNameShape(raw, tradingName)) return 'SOLE_TRADER_OR_OTHER';
  return 'FORM_INDETERMINATE';
}

// ── 5. Postcode completeness ─────────────────────────────────────────────────

// Full UK postcode (outward + inward), optional single space between them.
const FULL_UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-BD-HJLNP-UW-Z]{2}$/i;

function postcodeCompletenessClass(postcode) {
  const trimmed = String(postcode || '').trim();
  if (!trimmed) return 'POSTCODE_MISSING';
  return FULL_UK_POSTCODE_RE.test(trimmed) ? 'POSTCODE_COMPLETE' : 'POSTCODE_PARTIAL';
}

// ── 7. Region + urban/rural ─────────────────────────────────────────────────

// Bounded, fixed lookup — not exhaustive of every UK postcode area, but
// covers at least one prefix per documented region (>= 15-20 areas total),
// per the pilot spec's explicit "reasonably complete but bounded" allowance.
const REGION_BY_PREFIX = {
  // London
  EC: 'LONDON', WC: 'LONDON', N: 'LONDON', E: 'LONDON', SE: 'LONDON',
  SW: 'LONDON', W: 'LONDON', NW: 'LONDON',
  // South East
  GU: 'SOUTH_EAST', RH: 'SOUTH_EAST', TN: 'SOUTH_EAST',
  // South West
  BS: 'SOUTH_WEST', EX: 'SOUTH_WEST', PL: 'SOUTH_WEST', TR: 'SOUTH_WEST',
  // East of England
  CB: 'EAST_OF_ENGLAND', NR: 'EAST_OF_ENGLAND', IP: 'EAST_OF_ENGLAND', CM: 'EAST_OF_ENGLAND',
  // Midlands
  B: 'MIDLANDS', CV: 'MIDLANDS', LE: 'MIDLANDS', NG: 'MIDLANDS', DE: 'MIDLANDS', WS: 'MIDLANDS',
  // North England
  LS: 'NORTH_ENGLAND', M: 'NORTH_ENGLAND', L: 'NORTH_ENGLAND', S: 'NORTH_ENGLAND',
  NE: 'NORTH_ENGLAND', SR: 'NORTH_ENGLAND', BD: 'NORTH_ENGLAND', HU: 'NORTH_ENGLAND',
  // Wales
  CF: 'WALES', SA: 'WALES', LD: 'WALES', NP: 'WALES',
  // Scotland
  EH: 'SCOTLAND', G: 'SCOTLAND', AB: 'SCOTLAND', IV: 'SCOTLAND', KW: 'SCOTLAND', DD: 'SCOTLAND',
  // Northern Ireland
  BT: 'NORTHERN_IRELAND',
};

const URBAN_PREFIXES = new Set(['EC', 'WC', 'N', 'E', 'SE', 'SW', 'W', 'NW', 'M', 'B', 'LS', 'G', 'EH', 'L']);
const RURAL_PREFIXES = new Set(['TR', 'LD', 'IV', 'KW']);

/** Extracts a UK postcode's outward-area letter prefix (e.g. "SW1A 1AA" -> "SW"). */
function postcodeAreaPrefix(postcode) {
  const trimmed = String(postcode || '').trim().toUpperCase();
  if (!trimmed) return null;
  const m = trimmed.match(/^[A-Z]{1,2}/);
  return m ? m[0] : null;
}

function regionClass(postcode) {
  const prefix = postcodeAreaPrefix(postcode);
  if (!prefix) return 'REGION_UNKNOWN';
  return REGION_BY_PREFIX[prefix] || 'REGION_UNKNOWN';
}

function urbanRuralClass(postcode) {
  const prefix = postcodeAreaPrefix(postcode);
  if (!prefix) return 'MIXED_OR_UNVERIFIED';
  if (URBAN_PREFIXES.has(prefix)) return 'URBAN';
  if (RURAL_PREFIXES.has(prefix)) return 'RURAL';
  return 'MIXED_OR_UNVERIFIED';
}

// ── Aggregate: classify a full candidate record ──────────────────────────────

/**
 * classifyCandidate(record) -> classification labels for all 7 dimensions.
 * record: { businessName, tradingName, postcode } (registrationNumber not
 * needed for classification itself, but is expected to travel alongside).
 */
function classifyCandidate(record) {
  const { businessName, tradingName, postcode } = record || {};
  return {
    derivedCategory: derivedCategory(businessName),
    nameAmbiguityClass: nameAmbiguityClass(businessName),
    nameDivergenceClass: nameDivergenceClass(businessName, tradingName),
    entityFormClass: entityFormClass(businessName, tradingName),
    postcodeCompletenessClass: postcodeCompletenessClass(postcode),
    regionClass: regionClass(postcode),
    urbanRuralClass: urbanRuralClass(postcode),
    samplingRuleVersion: SAMPLING_RULE_VERSION,
  };
}

module.exports = {
  SAMPLING_RULE_VERSION,
  DERIVED_CATEGORIES,
  DERIVED_CATEGORY_KEYWORDS,
  categoryKeywords,
  GENERIC_TOKEN_STOPLIST,
  derivedCategory,
  nameAmbiguityClass,
  nameDivergenceClass,
  entityFormClass,
  postcodeCompletenessClass,
  regionClass,
  urbanRuralClass,
  postcodeAreaPrefix,
  classifyCandidate,
};
