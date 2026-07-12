'use strict';

// SECURITYHEADERS-QM-v1.0 — SOT-SECURITYHEADERS-001 (HTTP Security Headers)
// Category C — Control Transparency.
//
// Reference implementation of the FROZEN quality model. This module is the
// production scorer for the model whose:
//   structure   was fixed at SLG-116 (Stage 5 — additive weighted checklist,
//               NOT the single-gate-plus-multiplier shape used by TLS/Certificate,
//               because the candidate headers are independent, non-nested facts),
//   numbers     were calibrated at SLG-117 (Stage 6),
//   validation  was completed at SLG-118 (Stage 6 extended — five representative
//               organisations traced digit-for-digit), and
//   freeze      was ratified at SLG-120 (Stage 9 — SECURITYHEADERS-QM-v1.0).
//
// SECURITYHEADERS-QM-v1.0 is immutable. Its weights, bonuses, allowance
// mechanism, tier membership and exclusions are reproduced here EXACTLY as
// frozen and are never modified in code. Any change is a new model version and
// a new baseline, not an edit here.
//
// This score is the signal's OWN internal 0–100 quality score, on the same
// scale convention as every other frozen Signal Lab model. It is NOT the
// separate 001–999 Trust Score (SLG-032); mapping into that budget is a distinct
// downstream exercise and is intentionally independent of this module.
//
// ── The frozen model (SLG-117 §1) ──────────────────────────────────────────────
//
//   security_headers_quality =
//       MIN(100, MAX(0,
//           Σ(candidate contributions)
//         + Σ(contextual bonuses)
//         + disclosure_allowance ))
//
//   disclosure_allowance = MAX(0, 10 − 3×[Server present] − 7×[X-Powered-By present])
//
//   Candidates (independent positive credit on presence; nothing on absence):
//     Tier 1  Strict-Transport-Security, Content-Security-Policy   20 each
//     Tier 2  X-Frame-Options, X-Content-Type-Options              12 each
//     Tier 3  Referrer-Policy, Permissions-Policy                   8 each
//   Contextual bonuses (presence-only, NEVER penalised for absence — SLG-116 §4):
//     CSP-Report-Only micro-modifier  +2, ONLY if CSP also present (SLG-116 §3.1)
//     Cross-origin isolation bundle   +5 if COOP and COEP both present
//                                     +2 if exactly one of COOP/COEP (partial)
//     CORP                            +3 (independent)
//   Disclosure (reduce-only, inverse — SLG-116 §5): via the allowance above.
//   Dormant headers (13, SLG-116 §6): NOT READ ANYWHERE in this formula.
//
// ── Unknown ≠ Absent (SLG-116 §2) ──────────────────────────────────────────────
// A domain whose endpoint was not observed (endpoint_state ∉ {RESPONSE_OBSERVED})
// is NEVER scored and NEVER defaulted to zero. TIMEOUT in particular must never
// be read as evidence about header configuration (SLG-115 §1.2). Such rows return
// { scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null }, mirroring the
// sibling scorers (tls-quality.js, caa-quality.js, …).

const QUALITY_VERSION = '1.0';                       // SECURITYHEADERS-QM-v1.0
const MODEL_ID = 'SECURITYHEADERS-QM-v1.0';

// ── Frozen constants (SLG-117 §1) ──────────────────────────────────────────────
const TIER1_WEIGHT = 20;   // Strict-Transport-Security, Content-Security-Policy
const TIER2_WEIGHT = 12;   // X-Frame-Options, X-Content-Type-Options
const TIER3_WEIGHT = 8;    // Referrer-Policy, Permissions-Policy

const CSP_REPORT_ONLY_BONUS = 2;   // only when CSP also present (SLG-116 §3.1)
const ISOLATION_BUNDLE_BONUS = 5;  // COOP AND COEP both present (WHATWG joint requirement)
const ISOLATION_PARTIAL_BONUS = 2; // exactly one of COOP/COEP (partial progress)
const CORP_BONUS = 3;              // independent contextual signal

const DISCLOSURE_ALLOWANCE_BASE = 10;
const SERVER_REDUCTION = 3;
const X_POWERED_BY_REDUCTION = 7;

const SCORE_MIN = 0;
const SCORE_MAX = 100;                             // structural bound (obs. national max was 98)

const SCORED_ENDPOINT_STATE = 'RESPONSE_OBSERVED';

// The 13 Dormant headers (SLG-116 §6). Listed ONLY to make the exclusion
// auditable and testable — deliberately never consulted by the scoring maths.
const DORMANT_HEADERS = Object.freeze([
  'feature_policy',
  'cross_origin_opener_policy_report_only',
  'cross_origin_embedder_policy_report_only',
  'reporting_endpoints',
  'report_to',
  'nel',
  'origin_agent_cluster',
  'x_xss_protection',
  'expect_ct',
  'public_key_pins',
  'public_key_pins_report_only',
  'x_aspnet_version',
  'x_aspnetmvc_version',
]);

// ── Presence helper ────────────────────────────────────────────────────────────
// header_inventory field shape (SOT-SECURITYHEADERS-001 v1): each named field is
// { present, count, values[], first_position }. A field is only "present" when
// its own present flag is strictly true.
function isPresent(inventory, field) {
  const h = inventory && inventory[field];
  return !!h && h.present === true;
}

// scoreSecurityHeadersQuality(facts) — facts = a signal_securityheaders_v1 row
//   (or collector output) = { domain, endpoint_state, header_inventory }.
// →  { scored, reason?, score, breakdown, flags[], evidence }
function scoreSecurityHeadersQuality(facts) {
  // ── Unknown-state exclusion (Unknown ≠ Absent). Anything that is not a
  //    positively-observed HTTPS response is not scored and not floored. ────────
  if (!facts || facts.endpoint_state !== SCORED_ENDPOINT_STATE) {
    return {
      scored: false,
      reason: 'OBSERVATION_INCOMPLETE',
      score: null,
      endpointState: facts ? facts.endpoint_state ?? null : null,
    };
  }

  const inv = facts.header_inventory || {};
  const P = (field) => isPresent(inv, field);

  // ── Candidate contributions (positive credit on presence only) ──────────────
  const hsts = P('strict_transport_security');
  const csp = P('content_security_policy');
  const xfo = P('x_frame_options');
  const xcto = P('x_content_type_options');
  const rp = P('referrer_policy');
  const pp = P('permissions_policy');

  const candidates =
      (hsts ? TIER1_WEIGHT : 0)
    + (csp ? TIER1_WEIGHT : 0)
    + (xfo ? TIER2_WEIGHT : 0)
    + (xcto ? TIER2_WEIGHT : 0)
    + (rp ? TIER3_WEIGHT : 0)
    + (pp ? TIER3_WEIGHT : 0);

  // ── Contextual bonuses (presence-only; absence is neutral, never a penalty) ──
  const cspReportOnly = P('content_security_policy_report_only');
  const coop = P('cross_origin_opener_policy');
  const coep = P('cross_origin_embedder_policy');
  const corp = P('cross_origin_resource_policy');

  // CSP-Report-Only is a conditional micro-modifier on CSP — it counts ONLY when
  // an enforcing CSP is also present (SLG-116 §3.1); Report-Only alone earns
  // nothing (evidence of iteration is meaningless without a policy to iterate on).
  const cspReportOnlyBonus = (csp && cspReportOnly) ? CSP_REPORT_ONLY_BONUS : 0;

  // Cross-origin isolation is a single underlying practice (WHATWG requires both
  // headers together); scored as one bonus, not two, with partial credit for one.
  let isolationBonus = 0;
  if (coop && coep) isolationBonus = ISOLATION_BUNDLE_BONUS;
  else if (coop || coep) isolationBonus = ISOLATION_PARTIAL_BONUS;

  const corpBonus = corp ? CORP_BONUS : 0;

  const contextual = cspReportOnlyBonus + isolationBonus + corpBonus;

  // ── Disclosure allowance (reduce-only, inverse). Reserved 10 points that the
  //    two disclosure headers exhaust — NOT an open subtraction bolted onto a
  //    floor (SLG-117 §4: the open-subtraction design compressed 44.44% of the
  //    national population into an indistinguishable floor and was refined out). ─
  const serverPresent = P('server');
  const xPoweredByPresent = P('x_powered_by');
  const disclosureAllowance = Math.max(
    0,
    DISCLOSURE_ALLOWANCE_BASE
      - (serverPresent ? SERVER_REDUCTION : 0)
      - (xPoweredByPresent ? X_POWERED_BY_REDUCTION : 0),
  );

  // ── Total, bounded to the 0–100 structural safety range ─────────────────────
  const raw = candidates + contextual + disclosureAllowance;
  const score = Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw));

  // ── Evidence-only diagnostics: dormant headers observed on the wire. Recorded
  //    for reporting; they contribute NOTHING to the score (SLG-116 §6). ────────
  const dormantObserved = DORMANT_HEADERS.filter((f) => P(f));

  return {
    scored: true,
    score,
    breakdown: {
      candidates,
      contextual,
      disclosureAllowance,
      raw,
    },
    flags: dormantObserved.length ? ['DORMANT_HEADERS_OBSERVED'] : [],
    evidence: {
      candidatesPresent: {
        strict_transport_security: hsts,
        content_security_policy: csp,
        x_frame_options: xfo,
        x_content_type_options: xcto,
        referrer_policy: rp,
        permissions_policy: pp,
      },
      contextualPresent: {
        content_security_policy_report_only: cspReportOnly,
        cross_origin_opener_policy: coop,
        cross_origin_embedder_policy: coep,
        cross_origin_resource_policy: corp,
      },
      disclosurePresent: {
        server: serverPresent,
        x_powered_by: xPoweredByPresent,
      },
      dormantObserved,
    },
  };
}

module.exports = {
  scoreSecurityHeadersQuality,
  isPresent,
  MODEL_ID,
  QUALITY_VERSION,
  DORMANT_HEADERS,
  // Frozen constants exported for tests / downstream provenance only.
  TIER1_WEIGHT, TIER2_WEIGHT, TIER3_WEIGHT,
  CSP_REPORT_ONLY_BONUS, ISOLATION_BUNDLE_BONUS, ISOLATION_PARTIAL_BONUS, CORP_BONUS,
  DISCLOSURE_ALLOWANCE_BASE, SERVER_REDUCTION, X_POWERED_BY_REDUCTION,
  SCORE_MIN, SCORE_MAX, SCORED_ENDPOINT_STATE,
};
