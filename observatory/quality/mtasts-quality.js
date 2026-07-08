'use strict';

// MTA-STS Quality Model — Category D · Signal 3 — reference implementation.
//
// Converts observed MTA-STS facts (signal_facts_mtasts rows / mtasts-collector
// output) into an independent 0–100 Quality Score. This is signal quality ONLY;
// Trust Framework weighting is applied elsewhere and is intentionally independent
// of this score (SLG-043 Decision 001).
//
// The collector, DNS/HTTPS transport, schema and observation format are UNCHANGED —
// this module only reads facts already produced.
//
// Implements the model MTASTS-QM-v1.0 EXACTLY:
//   review        SLG-082 (collector review; observability; suitable unmodified)
//   baseline      SLG-083 (NOB-MTASTS-001 national population characterisation)
//   validation    SLG-084 (Stage 3 trust gate PASSED directly, no remediation)
//   variability   SLG-085 (Stage 4 classification)
//   design        SLG-086 (Stage 5 structure; no numbers)
//   calibration   SLG-087 (Stage 6 numeric values)
//   commissioned  SLG-088 (this implementation + migration 031 + verification)
//
// ***  Candidate for FROZEN status at Governance Freeze (SLG-089).  ***
//
// MTASTS-QM-v1.0 is independently derived from Category D evidence — it does NOT
// inherit the superseded Category C MTA-STS allocation (SLG-030/032/033/034/035/
// 036/037, all flagged category-superseded per ADR-COL-008). Any change after
// freeze requires a NEW VERSION (MTASTS-QM-v1.1 / v2.0), a NEW BASELINE, and a
// fresh pass of the SLG-043/SLG-064 lifecycle (P9/P10).
//
// ── The model (SLG-086 design, SLG-087 calibration) ──────────────────────────
//
// PRIMARY — a disposition/policy-primary state (SLG-064 §5 archetype), read from
// the JOINT (dns_sts_present × policy_mode) axis, gated by RFC 8461 §3.1's
// discovery-then-fetch sequencing (SLG-086 §2): policy_mode is only consulted
// when dns_sts_present === true. A domain with a fetchable well-known policy but
// no DNS record (SLG-082 L-1; 20.7% of all working policy endpoints nationally,
// SLG-083 §2) is NOT discoverable by a compliant sending MTA and is scored ABSENT.
//
//   ENFORCE            = 100  (dns_sts_present=true, policy_mode='enforce' — the
//                              only state that changes real delivery behaviour)
//   TESTING             = 25  (dns_sts_present=true, policy_mode='testing' — no
//                              delivery-behaviour change; TLS-RPT reporting value
//                              unrealised nationally, SLG-036/037; staging signal only)
//   NONE                = 15  (dns_sts_present=true, policy_mode='none' — genuine
//                              disclosure, zero operative protection)
//   PUBLISHED_UNUSABLE  =  0  (dns_sts_present=true, but fetch or parse failed —
//                              identical real-world protection to ABSENT)
//   ABSENT              =  0  (dns_sts_present=false, regardless of any policy
//                              found at the well-known URL — SLG-086 §2)
//   unobserved (dns_sts_present=null, OR true with policy outcome undetermined)
//                       = NOT SCORED — NO ROW is emitted (SLG-043 P1)
//
// SECONDARY MULTIPLIER (reduce-only, ≤ 1.0), applied only within ENFORCE:
//   Short cache lifetime   ×0.95   policy_max_age < 604,800s (1 week) — SLG-087 §2.
//                                  17.48% of national ENFORCE population (SLG-085 §2).
//
// Four further Secondary dimensions (own-endpoint TLS validity; redirect-based
// retrieval; multiple DNS records; non-standard policy fields) are COMPUTED and
// FLAGGED but UNCALIBRATED (near-zero or zero evidence within the national ENFORCE
// population — SLG-085 §2, SLG-086 §4) and MUST NOT influence score calculation,
// following the CAA-M3 / DNSSEC-legacy-algorithm precedent (retain-and-flag rather
// than discard or force-calibrate on thin evidence).
//
// ── Commissioning discipline ──────────────────────────────────────────────────
//
// dns_sts_present unknown is NEVER scored. When dns_sts_present=true, an
// undetermined policy outcome (policy_present=null) is NEVER defaulted to
// PUBLISHED_UNUSABLE or any other state — it is NOT SCORED (SLG-086 §3, "unobserved
// states"). A domain is scored only when the full joint disposition is confirmed
// observed.

const QUALITY_VERSION = '1.0';              // MTASTS-QM-v1.0
const MODEL_ID = 'MTASTS-QM-v1.0';

const PRIMARY_ENFORCE = 100;
const PRIMARY_TESTING = 25;
const PRIMARY_NONE    = 15;
const PRIMARY_FLOOR   = 0;                  // ABSENT and PUBLISHED_UNUSABLE share this floor

const MULT_SHORT_MAX_AGE = 0.95;            // calibrated (SLG-087 §2)
const MAX_AGE_FLOOR_SECONDS = 604800;       // 1 week — the calibrated threshold

const VALID_MODES = new Set(['enforce', 'testing', 'none']);

// scoreMtaStsQuality(facts) — facts = a signal_facts_mtasts row (or collector
// output with `domain`): { dns_sts_present, policy_present, policy_parse_success,
// policy_mode, policy_max_age, policy_tls_valid, policy_redirect_count,
// dns_multiple_sts_records, policy_unknown_fields }
// →  { scored, reason?, score, primary, primaryLabel, applied[], flags[] }
function scoreMtaStsQuality(facts) {
  const dnsPresent = facts.dns_sts_present;

  // Unknown on the DNS axis is never scored (P1) — it is the gate for everything else.
  if (dnsPresent == null) {
    return { scored: false, reason: 'DNS_UNOBSERVED', score: null, primaryLabel: null };
  }

  // ABSENT: DNS-mandated discovery point has no record. Any policy found at the
  // well-known URL regardless (SLG-082 L-1) confers no protection to a compliant
  // sender and is NOT consulted here (SLG-086 §2).
  if (dnsPresent === false) {
    return {
      scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR,
      primaryLabel: 'ABSENT', applied: [], flags: [],
    };
  }

  // dnsPresent === true from here on. Policy outcome must be fully determined.
  const policyPresent = facts.policy_present;

  if (policyPresent == null) {
    return { scored: false, reason: 'POLICY_UNOBSERVED', score: null, primaryLabel: null };
  }

  if (policyPresent === false || facts.policy_parse_success === false) {
    return {
      scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR,
      primaryLabel: 'PUBLISHED_UNUSABLE', applied: [], flags: [],
    };
  }

  // policyPresent === true && policy_parse_success === true from here on.
  const mode = facts.policy_mode;
  if (!VALID_MODES.has(mode)) {
    // Defensive: the parser guarantees parse_success=true implies a valid mode,
    // but never silently infer a state the data does not support (P1).
    return { scored: false, reason: 'MODE_INCONSISTENT_WITH_PARSE_SUCCESS', score: null, primaryLabel: null };
  }

  let state, primary;
  if (mode === 'enforce')      { state = 'ENFORCE'; primary = PRIMARY_ENFORCE; }
  else if (mode === 'testing') { state = 'TESTING'; primary = PRIMARY_TESTING; }
  else                          { state = 'NONE';    primary = PRIMARY_NONE; }

  const applied = [];
  let product = 1;

  // The max_age multiplier is structurally confined to ENFORCE (SLG-086 §4,
  // mirroring DNSSEC's SHA-1-digest multiplier being confined to ANCHORED) — cache
  // lifetime has no operative security consequence when nothing is being enforced.
  if (state === 'ENFORCE') {
    const maxAge = facts.policy_max_age;
    if (typeof maxAge === 'number' && maxAge < MAX_AGE_FLOOR_SECONDS) {
      applied.push({ name: 'Short cache lifetime (<1 week)', factor: MULT_SHORT_MAX_AGE });
      product *= MULT_SHORT_MAX_AGE;
    }
  }

  // Computed-and-flagged, uncalibrated Secondary dimensions (SLG-086 §4) — never
  // applied to score, evaluated for every scored ENFORCE domain for audit purposes.
  const flags = [];
  if (state === 'ENFORCE') {
    if (facts.policy_tls_valid === false) flags.push('UNCALIBRATED_TLS_INVALID_OWN_ENDPOINT');
    if ((facts.policy_redirect_count ?? 0) >= 1) flags.push('UNCALIBRATED_REDIRECT_BASED_RETRIEVAL');
    if (facts.dns_multiple_sts_records === true) flags.push('UNCALIBRATED_MULTIPLE_DNS_RECORDS');
    const unknownFields = facts.policy_unknown_fields;
    if (unknownFields && typeof unknownFields === 'object' && Object.keys(unknownFields).length > 0) {
      flags.push('UNCALIBRATED_NONSTANDARD_POLICY_FIELDS');
    }
  }

  return {
    scored: true,
    score: Math.round(primary * product * 100) / 100,
    primary,
    primaryLabel: state,
    applied,
    flags,
  };
}

module.exports = {
  scoreMtaStsQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_ENFORCE, PRIMARY_TESTING, PRIMARY_NONE, PRIMARY_FLOOR,
  MULT_SHORT_MAX_AGE, MAX_AGE_FLOOR_SECONDS,
};
