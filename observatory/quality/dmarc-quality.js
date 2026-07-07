'use strict';

// DMARC Quality Model — Category A · Signal 3 — reference implementation.
//
// Converts observed DMARC facts (the dmarc-collector output) into an independent
// 0–100 Quality Score. This is signal quality ONLY; overall Trust Framework
// weighting is applied elsewhere and is intentionally independent of this score.
//
// The collector, parsing, resolver, schema and observation format are unchanged —
// this module only reads facts already produced.
//
// Implements the calibrated model DMARC-QM-v1.0 (design SLG-059, calibration
// SLG-060) EXACTLY. Formal governance freeze is a separate, later act; this file
// is the commissioning reference implementation. Any change requires a new version
// and a new calibration — v1.0 values are never modified retrospectively.
//
// ── Model (SLG-059 design, SLG-060 calibration) ──────────────────────────────
//
// PRIMARY — the enforcement disposition (p=), SPF-anchored where semantics align:
//   p=reject        = 100   (RFC 7489 §6.3; = SPF -all)
//   p=quarantine    =  75
//   p=none          =  40   (present but non-enforcing; = SPF "Missing all" band)
//   no usable policy=   0   (absent | multiple records [RFC §6.6.3] | missing/invalid v/p)
//                           — a CONFIRMED floor (DMARC absence is complete, SLG-058)
//   unknown (DNS failure) = not scored (observation incomplete)
//
// SECONDARY MULTIPLIERS (reduce-only, applied multiplicatively to the primary):
//   M1 pct < 100                      ×0.90   (RFC §6.6.4 — policy partially applied)
//   M2 sp ranks below p (none<quar<rej) ×0.90 (subdomains under-protected; never on p=none)
//   M3 malformed record, p still valid  ×0.95 (readable policy carrying record defects)
//
// Multiple records / missing-or-invalid p → floor (0), NOT a multiplier.
// Omitted OPTIONAL tags (sp/adkim/aspf/pct) are never penalised (RFC defaults benign).

const QUALITY_VERSION = '1.0';           // DMARC-QM-v1.0 (calibrated; formal freeze pending)
const MODEL_ID = 'DMARC-QM-v1.0';

const PRIMARY_REJECT     = 100;
const PRIMARY_QUARANTINE = 75;
const PRIMARY_NONE       = 40;
const PRIMARY_FLOOR      = 0;            // no usable policy (confirmed floor)

const MULT_PCT_PARTIAL   = 0.90;         // M1
const MULT_SP_WEAKER     = 0.90;         // M2
const MULT_MALFORMED     = 0.95;         // M3

const NONOBSERVED = 'unknown';
const POLICY_RANK = { none: 0, quarantine: 1, reject: 2 };
const POLICY_PRIMARY = { reject: PRIMARY_REJECT, quarantine: PRIMARY_QUARANTINE, none: PRIMARY_NONE };

// scoreDmarcQuality(facts) — facts = collector output / signal_facts_dmarc row:
//   { dmarc_present, dmarc_collection_error, dmarc_multiple_records, dmarc_policy,
//     dmarc_subdomain_policy, dmarc_pct, dmarc_parse_success }
// →
//   { scored, reason?, score, primary, primaryLabel, applied[] }
function scoreDmarcQuality(facts) {
  // Unknown (DNS failure) → not scored (observation incomplete)
  if (facts.dmarc_collection_error != null || facts.dmarc_present == null) {
    return { scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null };
  }

  // Confirmed absent → floor
  if (facts.dmarc_present === false) {
    return { scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR, primaryLabel: 'absent', applied: [] };
  }

  // Present: usable policy requires a single well-formed-enough record with a valid p
  if (facts.dmarc_multiple_records === true) {
    return { scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR, primaryLabel: 'no usable policy (multiple records)', applied: [] };
  }
  const policy = facts.dmarc_policy;
  if (policy == null || POLICY_PRIMARY[policy] === undefined) {
    return { scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR, primaryLabel: 'no usable policy (no valid p)', applied: [] };
  }

  const primary = POLICY_PRIMARY[policy];
  const applied = [];
  let product = 1;

  // M1 — pct < 100
  if (facts.dmarc_pct != null && facts.dmarc_pct < 100) {
    applied.push({ name: 'pct < 100', factor: MULT_PCT_PARTIAL });
    product *= MULT_PCT_PARTIAL;
  }
  // M2 — sp ranks strictly below p (cannot fire on p=none)
  const sp = facts.dmarc_subdomain_policy;
  if (sp != null && POLICY_RANK[sp] != null && POLICY_RANK[sp] < POLICY_RANK[policy]) {
    applied.push({ name: 'sp weaker than p', factor: MULT_SP_WEAKER });
    product *= MULT_SP_WEAKER;
  }
  // M3 — malformed record with a still-valid p
  if (facts.dmarc_parse_success === false) {
    applied.push({ name: 'malformed record (valid p)', factor: MULT_MALFORMED });
    product *= MULT_MALFORMED;
  }

  return {
    scored: true,
    score: Math.round(primary * product * 100) / 100,
    primary, primaryLabel: policy, applied,
  };
}

module.exports = {
  scoreDmarcQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_REJECT, PRIMARY_QUARANTINE, PRIMARY_NONE, PRIMARY_FLOOR,
  MULT_PCT_PARTIAL, MULT_SP_WEAKER, MULT_MALFORMED, POLICY_RANK,
};
