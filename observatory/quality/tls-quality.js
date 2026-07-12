'use strict';

// TLS Quality Model — Category D · Signal 1 — reference implementation.
//
// Converts observed TLS configuration facts (signal_tls_v1 rows / tls-extractor.js
// output) into an independent 0–100 Quality Score. This is signal quality ONLY;
// Trust Framework weighting is applied elsewhere and is intentionally independent
// of this score.
//
// The collector, TLS Collection Domain Layer, schema and observation format are
// UNCHANGED — this module only reads facts already produced. Per SLG-097 §2's
// binding requirement, this module resolves SLG-095's L-4 (SI-002) finding at the
// quality-model layer: where the collector's `cipher_key_exchange` derivation is
// null on an otherwise RESPONSE_OBSERVED row, this module classifies static-RSA
// exchange directly from the always-preserved raw `cipher_suite_standard` field
// (testing for the `TLS_RSA_WITH_` IANA/RFC-name prefix) rather than relying on the
// collector's derivation. This is a quality-model classification, not a collector
// change — signal_tls_v1 and tls-collection-layer.js are untouched.
//
// Implements the model TLS-QM-v1.0 EXACTLY:
//   review        SLG-093 (Stage 1 — collector review; suitable unmodified)
//   baseline      SLG-094 (NOB-TLS-001 national population characterisation)
//   validation    SLG-095 (Stage 3 trust gate — ACCEPT; L-4/L-6 characterised)
//   variability   SLG-096 (Stage 4 — Fundamental: version, forward secrecy)
//   design        SLG-097 (Stage 5 — four-tier disposition ladder; no multiplier)
//   calibration   SLG-098 (Stage 6 — numeric values)
//
// ***  FROZEN as the production reference at the Governance Freeze (SLG-100).  ***
//
// TLS-QM-v1.0 is immutable. Its values and structure are never modified
// retrospectively. Any change — including recognising session-ticket/OCSP-stapling/
// key-share evidence once collectible, or reconsidering ALPN as a scoring
// dimension — requires a NEW VERSION (TLS-QM-v1.1 / v2.0), a NEW BASELINE, and a
// fresh pass of the SLG-064 lifecycle.
//
// ── The model (SLG-097 design, SLG-098 calibration) ──────────────────────────
//
// PRIMARY — a single ordered disposition ladder read from (negotiated_version,
// forward_secrecy-equivalent). Not a two-axis product (unlike DNSSEC's DS×DNSKEY):
// forward secrecy is a partial derivative of version, not an independent fact
// (SLG-096 §2.2).
//
//   CEILING        = 100  (TLSv1.3 — RFC 8446 mandates ephemeral exchange; always
//                          forward-secret. 91.365% of NOB-TLS-001's scored population)
//   UPPER_MIDDLE   =  90  (TLSv1.2 + ephemeral exchange, ECDHE or DHE — genuinely
//                          forward-secret, NIST SP 800-52 Rev.2 / NCSC-acceptable.
//                          8.545% of scored population)
//   LOWER_MIDDLE   =  25  (TLSv1.2 + static-RSA exchange — not forward-secret.
//                          0.107% of scored population, L-4-resolved per above)
//   FLOOR          =   0  (TLSv1.1 / TLSv1 / SSLv3 — RFC 7568-deprecated.
//                          Structurally-defined; 0% national population)
//
// No Secondary multiplier — SLG-097 §3 found no independently-discriminating
// Secondary dimension (`cipher_key_exchange` tracks the Primary ladder near-exactly).
//
// ALPN/HTTP-2 and symmetric-algorithm/MAC-hash choice are COMPUTED and FLAGGED
// (returned as informational fields) but NEVER influence score calculation
// (SLG-097 §4 — explicitly off-threat-model / no discriminating power respectively).
//
// ── Commissioning discipline ──────────────────────────────────────────────────
//
// `endpoint_state !== 'RESPONSE_OBSERVED'` (CONNECTION_ERROR / TLS_ERROR) is NEVER
// scored and NEVER defaulted to the floor (Unknown ≠ Absent, SOT-TLS-001 §6.1;
// SLG-097 §5). A domain whose TLS handshake could not be completed has not been
// shown to negotiate weak TLS — it has not been observed at all.

const QUALITY_VERSION = '1.0';              // TLS-QM-v1.0
const MODEL_ID = 'TLS-QM-v1.0';

const PRIMARY_CEILING      = 100;
const PRIMARY_UPPER_MIDDLE = 90;
const PRIMARY_LOWER_MIDDLE = 25;             // static-RSA — no forward secrecy
const PRIMARY_FLOOR        = 0;              // deprecated protocol versions

const DEPRECATED_VERSIONS = new Set(['TLSv1.1', 'TLSv1', 'SSLv3']);

// SLG-097 §2 binding resolution of SLG-095 L-4: when the collector's derived
// `cipher_key_exchange` is null, classify static-RSA exchange directly from the
// raw, always-preserved standard (RFC/IANA) cipher name.
const STATIC_RSA_STANDARD_PREFIX = 'TLS_RSA_WITH_';

// scoreTlsQuality(facts) — facts = a signal_tls_v1 row (or extractor output with
// `domain`): { endpoint_state, negotiated_version, cipher_suite_standard,
// cipher_key_exchange, forward_secrecy, alpn_protocol, http2_negotiated }
// →  { scored, reason?, score, primary, primaryLabel, flags[], evidence: {...} }
function scoreTlsQuality(facts) {
  if (facts.endpoint_state !== 'RESPONSE_OBSERVED') {
    return {
      scored: false,
      reason: 'NOT_OBSERVED',
      score: null,
      endpointState: facts.endpoint_state ?? null,
    };
  }

  const version = facts.negotiated_version;

  // A RESPONSE_OBSERVED row with no negotiated_version is a collection error
  // (SOT-TLS-001 §6.3), not a scorable/unknown state. Fail loudly rather than
  // silently score or silently skip.
  if (!version) {
    return { scored: false, reason: 'INVALID_OBSERVATION', score: null };
  }

  let state, primary;

  if (version === 'TLSv1.3') {
    state = 'CEILING';
    primary = PRIMARY_CEILING;
  } else if (DEPRECATED_VERSIONS.has(version)) {
    state = 'FLOOR';
    primary = PRIMARY_FLOOR;
  } else if (version === 'TLSv1.2') {
    // Resolve forward-secrecy tier for TLS 1.2. Prefer the collector's derived
    // field; when null (SLG-095 L-4), fall back to the raw standard cipher name
    // (SLG-097 §2's binding requirement) before giving up.
    let isEphemeral = facts.cipher_key_exchange === 'ECDHE' || facts.cipher_key_exchange === 'DHE';
    let isStaticRsa = facts.cipher_key_exchange === 'RSA';

    if (facts.cipher_key_exchange == null) {
      const standard = facts.cipher_suite_standard ?? '';
      if (standard.startsWith(STATIC_RSA_STANDARD_PREFIX)) {
        isStaticRsa = true;
      }
      // Any other unrecognised TLS 1.2 cipher (neither ephemeral nor identifiably
      // static-RSA) is a genuine collection/derivation gap beyond L-4's known
      // shape — do not guess; fall through to NOT_CLASSIFIABLE below.
    }

    if (isEphemeral) {
      state = 'UPPER_MIDDLE';
      primary = PRIMARY_UPPER_MIDDLE;
    } else if (isStaticRsa) {
      state = 'LOWER_MIDDLE';
      primary = PRIMARY_LOWER_MIDDLE;
    } else {
      return {
        scored: false,
        reason: 'NOT_CLASSIFIABLE',
        score: null,
        cipherSuiteStandard: facts.cipher_suite_standard ?? null,
      };
    }
  } else {
    // Any negotiated_version outside the known ladder (should not occur — the
    // collector's CHECK constraint enforces the enumerated set) is not silently
    // scored.
    return { scored: false, reason: 'UNRECOGNISED_VERSION', score: null, negotiatedVersion: version };
  }

  // ── Evidence-only fields (computed, flagged, never scored — SLG-097 §4) ────
  const flags = [];
  if (facts.alpn_protocol == null) flags.push('ALPN_NOT_NEGOTIATED');
  else if (facts.alpn_protocol !== 'h2') flags.push('ALPN_NOT_H2');

  return {
    scored: true,
    score: primary,
    primary,
    primaryLabel: state,
    flags,
    evidence: {
      alpnProtocol: facts.alpn_protocol ?? null,
      http2Negotiated: facts.http2_negotiated ?? null,
    },
  };
}

module.exports = {
  scoreTlsQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_CEILING, PRIMARY_UPPER_MIDDLE, PRIMARY_LOWER_MIDDLE, PRIMARY_FLOOR,
  DEPRECATED_VERSIONS, STATIC_RSA_STANDARD_PREFIX,
};
