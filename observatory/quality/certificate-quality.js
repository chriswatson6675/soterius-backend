'use strict';

// Certificate Quality Model — Category D · Signal 2 — reference implementation.
//
// Converts observed certificate facts (signal_certificate_v1 rows /
// certificate-extractor.js output) into an independent 0–100 Quality Score.
// This is signal quality ONLY; Trust Framework weighting is applied elsewhere
// and is intentionally independent of this score.
//
// The collector, TLS/Certificate Collection Domain (ADR-COL-003), schema and
// observation format are UNCHANGED by this module — it only reads facts
// already produced. It reads exclusively fields owned by SOT-CERTIFICATE-001
// (never negotiated_version/cipher_suite/forward_secrecy/alpn_protocol, which
// belong to the sibling, independently-frozen SOT-TLS-001/TLS-QM-v1.0).
//
// Implements the model CERTIFICATE-QM-v1.0 EXACTLY:
//   boundary      SLG-101 §0 (TLS/Certificate evidence-boundary confirmation)
//   review        SLG-101 (Stage 1 — collector review; suitable unmodified)
//   baseline      SLG-102 (NOB-CERTIFICATE-001 — pre-correction, superseded)
//   correction    SLG-103 (C-6/C-7 collector fix + regression validation)
//   re-baseline   SLG-104 (NOB-CERTIFICATE-001-v2 — corrected, authoritative)
//   validation    SLG-105 (Stage 3 trust gate — ACCEPT, 100% field agreement)
//   variability   SLG-106 (Stage 4 — 6 PROCEED, 3 PROCEED-with-open-question)
//   design        SLG-107 (Stage 5 — binary Primary + 4 candidate multipliers)
//   calibration   SLG-108 (Stage 6 — numeric values; M4 removed)
//   falsification SLG-109 (post-Stage-6 challenge — no additions found)
//
// ***  FROZEN as the production reference at the Governance Freeze.  ***
//
// CERTIFICATE-QM-v1.0 is immutable. Its values and structure are never
// modified retrospectively. Any change — including a future collector
// extension resolving C-1 (Certificate Policy OIDs) or C-7 (signature
// algorithm), or reconsidering M1's currently-inert RSA<2048 case — requires
// a NEW VERSION (CERTIFICATE-QM-v1.1 / v2.0), a NEW BASELINE, and a fresh
// pass of the SLG-064 lifecycle.
//
// ── The model (SLG-107 design, SLG-108 calibration, SLG-109 falsification) ──
//
// PRIMARY — strict binary, read from tls_verification_result. RFC 5280 §6
// defines path validation as a boolean determination with no partial-trust
// state; every non-CHAIN_VERIFIED outcome is hard-failed identically by every
// major browser/OS trust store, so no ordinal ranking is invented among them.
//
//   CEILING  = 100  (tls_verification_result === 'CHAIN_VERIFIED'.
//                    95.77% of NOB-CERTIFICATE-001-v2's scored population)
//   FLOOR    =   0  (every other tls_verification_result value —
//                    HOSTNAME_MISMATCH, CERT_EXPIRED, CHAIN_UNVERIFIABLE,
//                    SELF_SIGNED, SELF_SIGNED_IN_CHAIN, OTHER_TLS_ERROR.
//                    4.23% of scored population)
//
// leaf_is_self_signed is NOT a separate scoring input — SLG-106's cross-tab
// proved every self-signed domain already floors under Primary regardless of
// its specific tls_verification_result label (a self-signed cert is never in
// Node's default trust store, so it can never be CHAIN_VERIFIED). A standalone
// multiplier on it would be arithmetically inert (0 × anything = 0). It is
// surfaced only as a diagnostic annotation (`selfSigned` in the evidence
// object) so reporting never silently under-counts self-signed prevalence,
// particularly the ~65% of self-signed domains whose tls_verification_result
// is CERT_EXPIRED rather than SELF_SIGNED.
//
// SECONDARY — three reduce-only multipliers, applied ONLY when primary=100:
//
//   M1 — Key Strength (resolves RSA-vs-EC: no cross-family ranking; NIST SP
//        800-57 / CA/Browser Forum BR §6.1.5 treat RSA≥2048 and any currently-
//        observed EC curve as parity-strength). 0.50 if RSA < 2048 bits, else
//        1.00. Currently 0% population effect nationally (the sole national
//        RSA-1024 domain already floors under Primary for an unrelated
//        reason) — retained as a calibrated-but-inert standards safeguard,
//        per the CAA-M3/DNSSEC-algorithm-modernity "uncalibrated, retained
//        not discarded" precedent (SLG-108 §3).
//   M2 — Wildcard Exposure (blast-radius/key-compromise-scope property, not
//        cryptographic strength). 0.95 if leaf_is_wildcard === true, else
//        1.00 (false or null — D-2, no SAN to evaluate — both treated as
//        not-wildcard-exposed). 28.75% population effect (SLG-108 §4).
//   M3 — Lifetime/Issuance Modernity (resolves the lifetime question: shorter
//        validity is the CA/Browser Forum's own documented direction of
//        travel — max validity cut to 398 days in 2020 and continuing to
//        shrink — not the naive "longer = more established" reading, which
//        is backwards). 0.95 if leaf_lifetime_days > 100, else 1.00. The 100-
//        day threshold is a Stage-6 recalibration from Phase 5's 398-day
//        design sketch: within CHAIN_VERIFIED, zero certificates exceed 398
//        days (any publicly-trusted cert is CABF-capped there by
//        construction), so the real, evidence-grounded split sits at the gap
//        immediately after the 89–90-day Let's Encrypt/ACME issuance spike.
//        22.17% population effect (SLG-108 §5).
//
// M4 (AIA/OCSP-URL presence) was REMOVED at calibration (SLG-108 §6): its
// 63.52% national absence rate is 90.8% attributable to Let's Encrypt's
// documented OCSP-sunset policy alone (100% of Let's Encrypt's CHAIN_VERIFIED
// certificates lack an OCSP URL, vs ~0% absence for every other observed CA)
// — near-perfectly collinear with CA identity, which this model's principles
// already exclude from scoring. It is not implemented here at all.
//
// cert_chain_complete is NOT a scoring input (SLG-107 §5) — no protocol
// standard or CA/Browser Forum guidance ranks root-inclusion either
// direction; server deployment guidance recommends omitting the root
// regardless of "completeness" as this field defines it.
//
// ── Commissioning discipline ──────────────────────────────────────────────
//
// `endpoint_state !== 'RESPONSE_OBSERVED'` or `certificate_present !==
// 'CERTIFICATE_PRESENTED'` is NEVER scored and NEVER defaulted to the floor
// (Unknown ≠ Absent). A domain whose certificate could not be observed has
// not been shown to present a bad certificate — it has not been observed.

const QUALITY_VERSION = '1.0';                    // CERTIFICATE-QM-v1.0
const MODEL_ID = 'CERTIFICATE-QM-v1.0';

const PRIMARY_CEILING = 100;
const PRIMARY_FLOOR = 0;

const M1_RSA_MIN_BITS = 2048;      // CA/Browser Forum BR §6.1.5 minimum since 2014
const M1_WEAK_KEY_MULTIPLIER = 0.50;

const M2_WILDCARD_MULTIPLIER = 0.95;

const M3_LIFETIME_THRESHOLD_DAYS = 100;   // Stage 6 recalibration (SLG-108 §5)
const M3_LONG_LIFETIME_MULTIPLIER = 0.95;

// scoreCertificateQuality(facts) — facts = a signal_certificate_v1 row (or
// extractor output with `domain`): { endpoint_state, certificate_present,
// tls_verification_result, leaf_key_type, leaf_key_bits, leaf_key_curve,
// leaf_is_wildcard, leaf_is_self_signed, leaf_lifetime_days }
// → { scored, reason?, score, primary, primaryLabel, m1, m2, m3, evidence: {...} }
function scoreCertificateQuality(facts) {
  if (facts.endpoint_state !== 'RESPONSE_OBSERVED') {
    return {
      scored: false,
      reason: 'NOT_OBSERVED',
      score: null,
      endpointState: facts.endpoint_state ?? null,
    };
  }

  if (facts.certificate_present !== 'CERTIFICATE_PRESENTED') {
    // NO_CERTIFICATE / HANDSHAKE_INCOMPLETE — a RESPONSE_OBSERVED handshake
    // that nonetheless yielded no certificate evidence. Zero occurrences in
    // NOB-CERTIFICATE-001-v2, but structurally distinct from an unknown
    // connection outcome and must not be silently scored or floored either.
    return {
      scored: false,
      reason: 'NO_CERTIFICATE_EVIDENCE',
      score: null,
      certificatePresent: facts.certificate_present ?? null,
    };
  }

  const verification = facts.tls_verification_result;

  if (!verification) {
    // CERTIFICATE_PRESENTED with no verification result is a collection
    // error (should not occur — the collector always derives one), not a
    // scorable or unknown state. Fail loudly rather than silently score.
    return { scored: false, reason: 'INVALID_OBSERVATION', score: null };
  }

  // Diagnostic annotation only — never gates or multiplies the score
  // (see header note). Surfaced so floor-reason reporting never silently
  // under-counts self-signed prevalence.
  const selfSigned = facts.leaf_is_self_signed ?? null;

  if (verification !== 'CHAIN_VERIFIED') {
    return {
      scored: true,
      score: PRIMARY_FLOOR,
      primary: PRIMARY_FLOOR,
      primaryLabel: 'FLOOR',
      m1: null,
      m2: null,
      m3: null,
      evidence: {
        tlsVerificationResult: verification,
        selfSigned,
      },
    };
  }

  // ── CHAIN_VERIFIED: apply Secondary multipliers ────────────────────────

  // M1 — Key Strength. A missing/undetermined key type or bit count is never
  // penalised (Unknown ≠ Absent applied within the multiplier, not just the
  // Primary gate) — only a positively-identified sub-2048-bit RSA key
  // triggers the reduction.
  let m1 = 1.0;
  if (facts.leaf_key_type === 'RSA' && typeof facts.leaf_key_bits === 'number' && facts.leaf_key_bits < M1_RSA_MIN_BITS) {
    m1 = M1_WEAK_KEY_MULTIPLIER;
  }

  // M2 — Wildcard Exposure. false or null (D-2: no SAN to evaluate) both
  // receive the full multiplier — only a positively-identified wildcard
  // triggers the reduction.
  const m2 = facts.leaf_is_wildcard === true ? M2_WILDCARD_MULTIPLIER : 1.0;

  // M3 — Lifetime/Issuance Modernity. A missing lifetime is never penalised.
  let m3 = 1.0;
  if (typeof facts.leaf_lifetime_days === 'number' && facts.leaf_lifetime_days > M3_LIFETIME_THRESHOLD_DAYS) {
    m3 = M3_LONG_LIFETIME_MULTIPLIER;
  }

  const finalScore = Number((PRIMARY_CEILING * m1 * m2 * m3).toFixed(2));

  return {
    scored: true,
    score: finalScore,
    primary: PRIMARY_CEILING,
    primaryLabel: 'CEILING',
    m1,
    m2,
    m3,
    evidence: {
      tlsVerificationResult: verification,
      selfSigned,
      leafKeyType: facts.leaf_key_type ?? null,
      leafKeyBits: facts.leaf_key_bits ?? null,
      leafKeyCurve: facts.leaf_key_curve ?? null,
      leafIsWildcard: facts.leaf_is_wildcard ?? null,
      leafLifetimeDays: facts.leaf_lifetime_days ?? null,
    },
  };
}

module.exports = {
  scoreCertificateQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_CEILING, PRIMARY_FLOOR,
  M1_RSA_MIN_BITS, M1_WEAK_KEY_MULTIPLIER,
  M2_WILDCARD_MULTIPLIER,
  M3_LIFETIME_THRESHOLD_DAYS, M3_LONG_LIFETIME_MULTIPLIER,
};
