'use strict';

// Security.txt Quality Model — Category C — reference implementation.
//
// Converts observed security.txt facts (signal_securitytxt_v1 rows /
// securitytxt-collector.js output) into an independent 0–100 Quality Score.
// This is signal quality ONLY; Trust Framework weighting is applied elsewhere
// and is intentionally independent of this score.
//
// The collector, schema, and observation format are UNCHANGED — this module
// only reads facts already produced. No collector modification was found
// necessary at any stage of this signal's lifecycle (SLG-123/125).
//
// Implements the model SECURITYTXT-QM-v1.0 EXACTLY:
//   review        SLG-123 (Stage 1 — collector review; suitable unmodified)
//   baseline      SLG-124 (NOB-SECURITYTXT-001 national population characterisation)
//   validation    SLG-125 (Stage 3 trust gate — ACCEPT; content-type gate established)
//   landscape     SLG-126 (Stage 4 — candidate structure, content-type-as-gate)
//   design        SLG-127 (Stage 5 — four-state disposition ladder; no multiplier)
//   calibration   SLG-128 (Stage 6 — numeric values; MIDDLE revised 60→50)
//
// SECURITYTXT-QM-v1.0 is immutable once frozen (Stage 9). Its values and
// structure are never modified retrospectively. Any change — including scoring
// an optional field (Encryption, PGP-signing, Canonical, Preferred-Languages,
// Policy, Acknowledgments, Hiring) or reclassifying the strict-RFC-3339
// non-conformant `Expires` formats found at SLG-128 §2 — requires a NEW
// VERSION (SECURITYTXT-QM-v1.1 / v2.0), a NEW BASELINE, and a fresh pass of
// the SLG-064 lifecycle.
//
// ── The model (SLG-127 design, SLG-128 calibration) ──────────────────────────
//
// PRIMARY — a single ordered disposition ladder, gated on content-type
// conformance, then split on `Contact` presence and `Expires` freshness
// (nested-precondition structure, not an independent/additive checklist —
// SLG-126 §5 / SLG-127 §2):
//
//   Prerequisite gate (SLG-125/126, binding): a domain is only eligible for a
//   non-FLOOR state if `fetch_state = FOUND` AND `content_type` conforms to
//   `text/plain` at the SAME location (canonical checked first, then legacy —
//   mirroring the collector's own dual-location priority). A `text/html` (or
//   other non-conformant) response — the dominant SPA-catch-all false-positive
//   pattern found at national scale (SLG-124 §4, SLG-125 §2) — is NOT a
//   security.txt file under RFC 9116 §3's own MUST-level media-type
//   requirement, regardless of what a naive line-based parse of it extracts.
//
//   CEILING  = 100  (content-type conformant, `Contact` present, `Expires`
//                    present and future-dated — fully RFC 9116-conformant and
//                    current. 206/17,036 = 1.209% of NOB-SECURITYTXT-001)
//   MIDDLE   =  50  (content-type conformant, `Contact` present, but `Expires`
//                    missing, past-dated (stale), or unparsable — a working,
//                    reachable channel whose currency cannot be verified, per
//                    RFC 9116 §2.5.5's own rationale for the field.
//                    146/17,036 = 0.857%. Revised from the SLG-127 candidate
//                    of 60 to 50 at SLG-128 Stage 6, to restore this
//                    repository's convention of reserving the single largest
//                    ladder gap for the transition into full conformance, and
//                    to better reflect RFC 9116's textually equal mandatory
//                    status for `Contact` and `Expires`.)
//   MINIMAL  =  10  (content-type conformant, but `Contact` missing — a
//                    structurally correct file that fails at the one field
//                    that makes the channel usable at all; distinguished from
//                    FLOOR because a deliberate implementation attempt is
//                    evidenced, even though it does not function.
//                    13/17,036 = 0.076%)
//   FLOOR    =   0  (content-type non-conformant, OR `file_state` = ABSENT —
//                    no credible evidence of a working disclosure channel.
//                    16,671/17,036 = 97.86%)
//
// No Secondary multiplier — final_score = primary_score always (SLG-127 §4 /
// SLG-128 §8). Every optional RFC 9116 field (Encryption, PGP-signing,
// Canonical, Preferred-Languages, Policy, Acknowledgments, Hiring) is
// COMPUTED and FLAGGED (returned as informational evidence) but NEVER
// influences score calculation — none was found to justify differentiation
// (SLG-127 §3, reconfirmed at national scale SLG-128 §6). Encryption and
// PGP-signing in particular fail RFC 9116's own friction-reduction purpose
// (they protect an already-sent report's confidentiality/integrity, they do
// not make reporting easier); PGP-signing is additionally excluded because
// the collector only detects clearsign STRUCTURE, never cryptographically
// verifies the signature (SLG-123 §2.2) — scoring an unverified observable
// would itself be an evidence-preservation violation.
//
// `Expires` freshness is determined with a permissive (JS `Date`) parse, per
// SLG-128 §2/§8: the six historically-unparsable values were tested against a
// strict RFC 3339 grammar and found either genuinely invalid (2) or
// human-inferable-but-not-machine-verifiable (4) — none were reclassified.
// An unparsable `Expires` value is treated identically to a missing one
// (MIDDLE), never promoted to CEILING by inference.
//
// ── Commissioning discipline ──────────────────────────────────────────────────
//
// `file_state === 'INDETERMINATE'` is NEVER scored and NEVER defaulted to the
// floor (Unknown ≠ Absent, SLG-125 §2's own re-confirmation of this
// principle). A domain that could not be determined (e.g. a transient
// connection error at collection time) has not been shown to lack a
// disclosure channel — it has not been observed at all.

const QUALITY_VERSION = '1.0';                    // SECURITYTXT-QM-v1.0
const MODEL_ID = 'SECURITYTXT-QM-v1.0';

const PRIMARY_CEILING = 100;
const PRIMARY_MIDDLE  = 50;                       // revised from the SLG-127 candidate of 60 at SLG-128 Stage 6
const PRIMARY_MINIMAL = 10;
const PRIMARY_FLOOR   = 0;

const CONTENT_TYPE_CONFORMANT = /^text\/plain/i;  // RFC 9116 §3 — MUST be text/plain (charset=utf-8 default)

function isConformantFetch(fetch) {
  return !!fetch && fetch.fetch_state === 'FOUND' && CONTENT_TYPE_CONFORMANT.test(fetch.content_type ?? '');
}

function hasField(parse, field) {
  const arr = parse?.[field];
  return Array.isArray(arr) && arr.length > 0;
}

// scoreSecuritytxtQuality(facts) — facts = a signal_securitytxt_v1 row:
// { domain, file_state, collected_at, canonical_fetch, legacy_fetch,
//   canonical_parse, legacy_parse }
// →  { scored, reason?, score, primary, primaryLabel, flags[], evidence: {...} }
function scoreSecuritytxtQuality(facts) {
  if (facts.file_state === 'INDETERMINATE') {
    return { scored: false, reason: 'NOT_DETERMINED', score: null };
  }

  // ── Prerequisite gate: content-type conformance at a FOUND location,
  // canonical checked first (mirrors the collector's own dual-location
  // priority order, SLG-123 §2.1) ──────────────────────────────────────────
  let parse = null;
  if (isConformantFetch(facts.canonical_fetch)) {
    parse = facts.canonical_parse;
  } else if (isConformantFetch(facts.legacy_fetch)) {
    parse = facts.legacy_parse;
  }

  if (!parse) {
    // Covers file_state = ABSENT, and the SPA-catch-all false-positive
    // majority (FOUND but non-conformant content-type) alike — neither
    // constitutes credible evidence of a working disclosure channel.
    return {
      scored: true, score: PRIMARY_FLOOR, primary: PRIMARY_FLOOR, primaryLabel: 'FLOOR',
      flags: [], evidence: {},
    };
  }

  if (!hasField(parse, 'contact')) {
    return {
      scored: true, score: PRIMARY_MINIMAL, primary: PRIMARY_MINIMAL, primaryLabel: 'MINIMAL',
      flags: evidenceFlags(parse), evidence: buildEvidence(parse),
    };
  }

  let state, primary;
  if (!hasField(parse, 'expires')) {
    state = 'MIDDLE'; primary = PRIMARY_MIDDLE;               // mandatory field missing
  } else {
    const raw = parse.expires[0];
    const expiresAt = new Date(typeof raw === 'string' ? raw.trim() : raw);
    const collectedAt = new Date(facts.collected_at);
    if (isNaN(expiresAt.getTime())) {
      state = 'MIDDLE'; primary = PRIMARY_MIDDLE;              // unparsable — SLG-128 §2, not promoted by inference
    } else if (expiresAt.getTime() > collectedAt.getTime()) {
      state = 'CEILING'; primary = PRIMARY_CEILING;            // present and future-dated
    } else {
      state = 'MIDDLE'; primary = PRIMARY_MIDDLE;               // present but past-dated (stale)
    }
  }

  return {
    scored: true, score: primary, primary, primaryLabel: state,
    flags: evidenceFlags(parse), evidence: buildEvidence(parse),
  };
}

// ── Evidence-only fields (computed, flagged, never scored — SLG-127 §3) ─────
function evidenceFlags(parse) {
  const flags = [];
  if (hasField(parse, 'encryption')) flags.push('ENCRYPTION_PRESENT');
  if (parse?.content_state === 'SIGNED') flags.push('PGP_SIGNED');
  if (hasField(parse, 'canonical')) flags.push('CANONICAL_PRESENT');
  if (hasField(parse, 'preferred_languages')) flags.push('PREFERRED_LANGUAGES_PRESENT');
  if (hasField(parse, 'policy')) flags.push('POLICY_PRESENT');
  if (hasField(parse, 'acknowledgments')) flags.push('ACKNOWLEDGMENTS_PRESENT');
  if (hasField(parse, 'hiring')) flags.push('HIRING_PRESENT');
  return flags;
}

function buildEvidence(parse) {
  return {
    encryptionPresent: hasField(parse, 'encryption'),
    pgpSigned: parse?.content_state === 'SIGNED',
    canonicalPresent: hasField(parse, 'canonical'),
    preferredLanguagesPresent: hasField(parse, 'preferred_languages'),
    policyPresent: hasField(parse, 'policy'),
    acknowledgmentsPresent: hasField(parse, 'acknowledgments'),
    hiringPresent: hasField(parse, 'hiring'),
  };
}

module.exports = {
  scoreSecuritytxtQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_CEILING, PRIMARY_MIDDLE, PRIMARY_MINIMAL, PRIMARY_FLOOR,
  CONTENT_TYPE_CONFORMANT,
};
