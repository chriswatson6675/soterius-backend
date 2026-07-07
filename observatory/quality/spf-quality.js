'use strict';

// SPF Quality Model — Category A · Signal 1
//
// Converts observed SPF facts (the spf-collector output) into an independent
// 0–100 Quality Score. This is signal quality ONLY; overall Trust Framework
// weighting is applied elsewhere and is intentionally independent of this score.
//
// The collector, parsing, resolver, retry behaviour, schema and observation
// format are unchanged — this module only reads facts already produced.
//
// ── Model (as agreed at SPF calibration) ─────────────────────────────────────
//
// PRIMARY SCORE (from the terminal disposition):
//   -all        = 100     ~all = 90     ?all = 60
//   Missing all =  40     +all =  5     Absent = 0
//   Unknown     = not scored (observation incomplete)
//
// SECONDARY MULTIPLIERS (applied multiplicatively to the primary):
//   Multiple SPF records ×0.00   (fatal)
//   Invalid version      ×0.00   (fatal)
//   Unknown mechanism    ×0.00   (fatal)
//   Malformed include    ×0.00   (fatal)
//   Malformed IP         ×0.00   (fatal)
//   Invalid IP           ×0.00   (fatal)
//   Duplicate all        ×0.95
//   All not last         ×0.90
//   Near lookup limit    ×0.95   (top-level lookup_count ≥ 8; the Stage-3
//                                 "near limit" band is 8–10)
//
// "Missing all" is represented SOLELY by its primary score (40). It is not a
// multiplier and is never penalised twice (frozen decision, SPF calibration).
// A present record with no `all` mechanism — whether flagged
// MISSING_ALL_MECHANISM or a `redirect=` record (redirect substitutes for `all`
// per RFC 7208 §6.1) — takes the Missing-all primary (40); the model defines no
// separate `redirect` primary state.

const QUALITY_VERSION = '1.0';

const PRIMARY = { '-all': 100, '~all': 90, '?all': 60, '+all': 5 };
const MISSING_ALL_PRIMARY = 40;   // present, no `all` qualifier
const ABSENT_PRIMARY = 0;

const NEAR_LOOKUP_LIMIT = 8;      // Stage-3 "near limit" = 8–10 top-level lookups

// Multiplier definitions, in a fixed order. `test(facts, codes)` → applies?
const MULTIPLIERS = [
  { name: 'Multiple SPF records', factor: 0.00, fatal: true,  test: (f, c) => f.spf_multiple_records === true || (f.spf_record_count || 0) > 1 || c.has('MULTIPLE_SPF_RECORDS') },
  { name: 'Invalid version',      factor: 0.00, fatal: true,  test: (f, c) => c.has('INVALID_VERSION') },
  { name: 'Unknown mechanism',    factor: 0.00, fatal: true,  test: (f, c) => c.has('UNKNOWN_MECHANISM') },
  { name: 'Malformed include',    factor: 0.00, fatal: true,  test: (f, c) => c.has('MALFORMED_INCLUDE') },
  { name: 'Malformed IP',         factor: 0.00, fatal: true,  test: (f, c) => c.has('MALFORMED_IP4') || c.has('MALFORMED_IP6') },
  { name: 'Invalid IP',           factor: 0.00, fatal: true,  test: (f, c) => c.has('INVALID_IP4') || c.has('INVALID_IP4_CIDR') },
  { name: 'Duplicate all',        factor: 0.95, fatal: false, test: (f, c) => c.has('DUPLICATE_ALL') },
  { name: 'All not last',         factor: 0.90, fatal: false, test: (f, c) => c.has('ALL_NOT_LAST') },
  { name: 'Near lookup limit',    factor: 0.95, fatal: false, test: (f) => f.spf_lookup_count != null && f.spf_lookup_count >= NEAR_LOOKUP_LIMIT },
];

function primaryScore(facts) {
  if (facts.spf_present === false) return { value: ABSENT_PRIMARY, label: 'Absent' };
  const mech = facts.spf_mechanism;
  if (mech && PRIMARY[mech] !== undefined) return { value: PRIMARY[mech], label: mech };
  return { value: MISSING_ALL_PRIMARY, label: 'Missing all' };  // present, no `all`
}

// scoreSpfQuality(facts) → {
//   scored: boolean,                     // false only for Unknown observations
//   reason?: 'OBSERVATION_INCOMPLETE',
//   score: number|null,                  // 0–100, or null when not scored
//   primary: number, primaryLabel: string,
//   applied: Array<{name, factor}>,      // multipliers that fired
//   fatal: boolean,                      // a ×0.00 multiplier reduced it to zero
// }
function scoreSpfQuality(facts) {
  if (facts.spf_present === null || facts.spf_present === undefined) {
    return { scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null };
  }

  const codes = new Set((facts.spf_syntax_errors || []).map(e => e.code));
  const primary = primaryScore(facts);

  const applied = [];
  let product = 1;
  let fatal = false;
  for (const m of MULTIPLIERS) {
    if (m.test(facts, codes)) {
      applied.push({ name: m.name, factor: m.factor });
      product *= m.factor;
      if (m.fatal) fatal = true;
    }
  }

  return {
    scored: true,
    score: primary.value * product,
    primary: primary.value,
    primaryLabel: primary.label,
    applied,
    fatal,
  };
}

module.exports = { scoreSpfQuality, QUALITY_VERSION, PRIMARY, MISSING_ALL_PRIMARY, ABSENT_PRIMARY, NEAR_LOOKUP_LIMIT, MULTIPLIERS };
