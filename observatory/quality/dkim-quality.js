'use strict';

// DKIM Quality Model — Category A · Signal 2 — FROZEN reference implementation.
//
// Converts observed DKIM facts (the dkim-collector output) into an independent
// 0–100 Quality Score. This is signal quality ONLY; overall Trust Framework
// weighting is applied elsewhere and is intentionally independent of this score.
//
// The collector, parsing, resolver, retry behaviour, schema and observation
// format are unchanged — this module only reads facts already produced.
//
// Frozen as DKIM-QM-v1.0 at Stage 7 (SLG-054), calibrated in SLG-053 over the
// validated national baseline NOB-DKIM-001R. Any change requires a new version
// and a new calibration — v1.0 is never modified retrospectively (SLG-043 P9/P10).
//
// ── Model (SLG-052 design, SLG-053 calibration) ──────────────────────────────
//
// PRIMARY — the strongest USABLE key (well-formed + live), graded by
// cryptographic strength (RFC 8301 tiers):
//   usable key >= 2048-bit   = 100   (RFC 8301 recommended)
//   usable key  = 1024-bit   =  85   (RFC 8301 minimum, below recommendation)
//   usable key  < 1024-bit   =  40   (below RFC 8301 minimum; deprecated)
//   no usable key observed   =   0   (NOT_DETECTED, or present-but-all-unusable;
//                                     a probe-set-BOUNDED floor — DKIM absence is
//                                     unprovable, SLG-047 §5.1 — not confirmed absence)
//   unobserved (DNS failure) = not scored (observation incomplete)
//
// SECONDARY MULTIPLIERS (reduce-only, applied multiplicatively to the primary):
//   M1 Malformed record present alongside a usable key   ×0.95
//   M2 Live sub-1024 key present alongside a >=1024 key   ×0.80  (residual factorable exposure)
//   M3 Strongest usable key in testing mode (t=y)         ×0.90  (domain-declared non-authoritative)
//
// A "usable" key is parse_success && public_key_present && key_bits != null.
// Strength uses key_bits (RSA modulus). Ed25519 has no key_bits and is ABSENT in
// the national baseline (0 keys); algorithm-based strength is a LATENT rule
// deferred to a future version (SLG-052 §6) — a pure-Ed25519 domain would fall to
// the floor under v1.0; this affects zero domains today and is documented, not
// silently handled.

const QUALITY_VERSION = '1.0';           // DKIM-QM-v1.0
const MODEL_ID = 'DKIM-QM-v1.0';

const PRIMARY_STRONG  = 100;             // >= 2048-bit  (RFC 8301 recommended)
const PRIMARY_MINIMUM = 85;              // == 1024-bit  (RFC 8301 minimum)
const PRIMARY_WEAK    = 40;              // <  1024-bit  (below RFC 8301 minimum)
const PRIMARY_NONE    = 0;               // no usable key observed (bounded floor)

const ADEQUACY_FLOOR  = 1024;            // RFC 8301 minimum modulus (bits)

const MULT_MALFORMED     = 0.95;         // M1
const MULT_WEAK_RESIDUAL = 0.80;         // M2
const MULT_TESTING       = 0.90;         // M3

const NONOBSERVED_STATUS = new Set(['DNS_FAILURE', 'DNS_SERVFAIL', 'DNS_TIMEOUT']);

// A key is usable for scoring if it is well-formed, live, and its strength is
// measurable (RSA modulus present).
function isUsable(k) {
  return k && k.parse_success === true && k.public_key_present === true && k.key_bits != null;
}

// scoreDkimQuality(facts) — facts = collector output:
//   { dkim_present, dkim_collection_status, dkim_keys: [{ parse_success,
//     public_key_present, key_bits, key_type, flags }, ...] }
// →
//   { scored, reason?, score, primary, primaryLabel, applied[], maxBits }
function scoreDkimQuality(facts) {
  if (NONOBSERVED_STATUS.has(facts.dkim_collection_status)) {
    return { scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null };
  }

  const keys = Array.isArray(facts.dkim_keys) ? facts.dkim_keys : [];
  const usable = keys.filter(isUsable);

  if (usable.length === 0) {
    return {
      scored: true, score: PRIMARY_NONE, primary: PRIMARY_NONE,
      primaryLabel: 'no usable key (bounded)', applied: [], maxBits: null,
    };
  }

  const maxBits = Math.max(...usable.map(k => k.key_bits));
  let primary, primaryLabel;
  if (maxBits >= 2048)       { primary = PRIMARY_STRONG;  primaryLabel = '>=2048'; }
  else if (maxBits === 1024) { primary = PRIMARY_MINIMUM; primaryLabel = '1024'; }
  else                       { primary = PRIMARY_WEAK;    primaryLabel = '<1024'; }

  const applied = [];
  let product = 1;

  // M1 — a malformed (unparseable) record co-published with usable keys
  if (keys.some(k => k.parse_success === false)) {
    applied.push({ name: 'Malformed record present', factor: MULT_MALFORMED });
    product *= MULT_MALFORMED;
  }
  // M2 — a live key below the adequacy floor alongside an adequate key
  if (maxBits >= ADEQUACY_FLOOR && usable.some(k => k.key_bits < ADEQUACY_FLOOR)) {
    applied.push({ name: 'Live sub-1024 residual key', factor: MULT_WEAK_RESIDUAL });
    product *= MULT_WEAK_RESIDUAL;
  }
  // M3 — the strongest usable key is flagged testing (t=y)
  if (usable.some(k => k.key_bits === maxBits && Array.isArray(k.flags) && k.flags.includes('y'))) {
    applied.push({ name: 'Strongest key in testing (t=y)', factor: MULT_TESTING });
    product *= MULT_TESTING;
  }

  return {
    scored: true,
    score: Math.round(primary * product * 100) / 100,
    primary, primaryLabel, applied, maxBits,
  };
}

module.exports = {
  scoreDkimQuality, isUsable,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_STRONG, PRIMARY_MINIMUM, PRIMARY_WEAK, PRIMARY_NONE,
  ADEQUACY_FLOOR, MULT_MALFORMED, MULT_WEAK_RESIDUAL, MULT_TESTING,
};
