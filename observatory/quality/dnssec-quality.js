'use strict';

// DNSSEC Quality Model — Category B · Signal 2 — reference implementation.
//
// Converts observed DNSSEC facts (signal_facts_dnssec rows / dnssec-collector output)
// into an independent 0–100 Quality Score. This is signal quality ONLY; Trust
// Framework weighting is applied elsewhere and is intentionally independent of
// this score.
//
// The collector, DoH transport, schema and observation format are UNCHANGED — this
// module only reads facts already produced. It reads `dns_ds_present`,
// `dns_dnskey_present`, `ds_digest_types` and `dnskey_algorithms` ONLY — these are
// observed or mechanically-derived fields (never the D-1-affected `dnskey_key_tags`
// array; see SLG-080 §9).
//
// Implements the model DNSSEC-QM-v1.0 EXACTLY:
//   review        SLG-075 (collector review; observability; suitable unmodified)
//   baseline      SLG-076 (NOB-DNSSEC-001 national population characterisation)
//   validation    SLG-077 (Stage 3 trust gate PASSED; suitability preview)
//   design        SLG-078 (Stage 4/5 candidate structure; corrected in place by SLG-079)
//   structural QA SLG-079 (Stage 6 structural validation; PASSES)
//   calibration   SLG-080 (Stage 6 numeric values; Founder ordinal decision)
//   commissioned  SLG-081 (this implementation + migration 030 + verification)
//
// ***  FROZEN as the production reference at the Governance Freeze.  ***
//
// DNSSEC-QM-v1.0 is immutable. Its values, states, and multiplier are never modified
// retrospectively (SLG-043 P9/P10). Any change — including calibrating the
// DNSKEY-algorithm-modernity multiplier once national evidence grows, resolving the
// Anchored-vs-Island multiplier-scope question, or fixing collector defect D-1 —
// requires a NEW VERSION (DNSSEC-QM-v1.1 / v2.0), a NEW BASELINE, and a fresh pass
// of the SLG-043 lifecycle.
//
// ── The model (SLG-078 design, SLG-080 calibration) ──────────────────────────
//
// PRIMARY — a presence/configuration state derived from the joint DS×DNSKEY status
// (SLG-078 §3.1: the only SLG-064 §5 archetype the evidence supports — validity/chain
// is unobserved, SLG-075 R4; pure strength/material is foreclosed, SLG-076 §10).
// Founder ordinal decision (2026-07-08): Unsigned → Island of Security → Anchored.
//
//   ANCHORED  = 100  (DS present AND DNSKEY present — RFC 4035 §5.2's anchoring test;
//                     cryptographically confirmed for 682/682 zones at Stage 3, SLG-077 §6.9)
//   ISLAND    =  40  (DNSKEY present, DS absent — RFC 4033 §2 "island of security": signed,
//                     zero validation benefit, RFC 4035 §5.2. Value anchored to
//                     DMARC-QM-v1.0's frozen p=none=40 — SLG-080 §2.3 — the Founder's own
//                     rationale cites DMARC policy-progression precedent by name; no
//                     DNSSEC-internal mathematical decomposition was available)
//   UNSIGNED  =   0  (DS absent, DNSKEY absent — RFC 4035 §5.2 Insecure. A CONFIRMED floor)
//   unobserved (either axis) = NOT SCORED (SLG-043 P1)
//
// The fourth logically possible cell — DS present, DNSKEY absent — is empirically
// impossible nationally (n=0/17,057, SLG-076 Finding P1) and is the RFC 4035 §5.5-
// predicted consequence of a validating DoH transport (SLG-077 §5). It is NEVER
// silently folded into another state; see ANOMALOUS_STATE_DS_WITHOUT_DNSKEY below.
//
// SECONDARY MULTIPLIER (reduce-only, ≤ 1.0), applied only within ANCHORED:
//   DS-digest modernity   ×0.95   SHA-1 (digest type 1) present in the DS RRset
//                                 (RFC 8624 §3.3 NOT RECOMMENDED). Triggers on ANY
//                                 SHA-1 presence, regardless of a co-published modern
//                                 digest — SLG-080 §3.1 explicitly considered and
//                                 REJECTED a finer SHA-1-only-vs-plus-modern split as
//                                 unsupported by RFC 8624's text.
//
// DNSKEY-algorithm modernity (algorithms 5, 7, 10 — RFC 8624 §3.1 MUST-NOT/NOT-
// RECOMMENDED) is COMPUTED and FLAGGED but is UNCALIBRATED (corrected national
// population 2/682 within scope — SLG-079 §5) and MUST NOT influence score
// calculation (SLG-080 §3.2), following the CAA-M3 precedent (SLG-074) of
// retain-and-flag rather than discard.
//
// ── Commissioning discipline ──────────────────────────────────────────────────
//
// Unknown on EITHER axis is NEVER scored and NEVER partially inferred — a domain
// with DS confirmed absent but DNSKEY unobserved is NOT defaulted to UNSIGNED, since
// DNSKEY's true value is exactly what distinguishes UNSIGNED from ISLAND (SLG-080 §8;
// a P1 violation to do otherwise). A domain is scored only when BOTH axes are
// confirmed observed (`true`/`false`, never `null`).

const QUALITY_VERSION = '1.0';              // DNSSEC-QM-v1.0
const MODEL_ID = 'DNSSEC-QM-v1.0';

const PRIMARY_ANCHORED = 100;
const PRIMARY_ISLAND   = 40;                // anchored to DMARC-QM-v1.0's p=none (SLG-080 §2.3)
const PRIMARY_UNSIGNED = 0;                 // confirmed floor

const MULT_SHA1_DS_DIGEST = 0.95;           // calibrated (SLG-080 §3.1)

// RFC 8624 §3.1 — MUST NOT (5, 7) / NOT RECOMMENDED (10) signing algorithms.
// Algorithms 14 and 15 are RFC 8624-approved/modern and are correctly EXCLUDED
// (SLG-079 §5 corrected an earlier drafting error that had included them).
const LEGACY_DNSKEY_ALGORITHMS = new Set([5, 7, 10]);

const SHA1_DIGEST_TYPE = 1;

// scoreDnssecQuality(facts) — facts = a signal_facts_dnssec row (or collector output
// with `domain`): { dns_ds_present, dns_dnskey_present, ds_digest_types,
// dnskey_algorithms, ds_collection_error, dnskey_collection_error }
// →  { scored, reason?, score, primary, primaryLabel, applied[], flags[] }
function scoreDnssecQuality(facts) {
  const ds = facts.dns_ds_present;
  const dk = facts.dns_dnskey_present;

  // Unknown on EITHER axis is never scored, and never partially inferred (P1).
  if (ds == null || dk == null) {
    return {
      scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null,
      dsCollectionError: facts.ds_collection_error ?? null,
      dnskeyCollectionError: facts.dnskey_collection_error ?? null,
    };
  }

  // The empirically-impossible cell. Never silently scored — flagged distinctly so a
  // caller halts, exactly as CAA's PROHIBITED/CR-3 treats an unexpected observed state.
  if (ds === true && dk === false) {
    return { scored: false, reason: 'ANOMALOUS_STATE_DS_WITHOUT_DNSKEY', score: null,
             primaryLabel: 'ANOMALOUS' };
  }

  let state, primary;
  if (ds === false && dk === false)      { state = 'UNSIGNED'; primary = PRIMARY_UNSIGNED; }
  else if (ds === false && dk === true)  { state = 'ISLAND';   primary = PRIMARY_ISLAND; }
  else                                   { state = 'ANCHORED'; primary = PRIMARY_ANCHORED; }

  const applied = [];
  let product = 1;

  // The DS-digest multiplier is structurally confined to ANCHORED — a DS digest
  // cannot exist without a DS, and DS presence is what defines ANCHORED (SLG-079 §2.3).
  if (state === 'ANCHORED') {
    const digestTypes = facts.ds_digest_types || [];
    if (digestTypes.includes(SHA1_DIGEST_TYPE)) {
      applied.push({ name: 'SHA-1 DS digest present', factor: MULT_SHA1_DS_DIGEST });
      product *= MULT_SHA1_DS_DIGEST;
    }
  }

  // DNSKEY-algorithm modernity — computed and flagged for EVERY state that publishes
  // DNSKEYs (ANCHORED and ISLAND both do), never applied (uncalibrated, SLG-080 §3.2).
  const dnskeyAlgorithms = facts.dnskey_algorithms || [];
  const legacyAlgorithmPresent = dnskeyAlgorithms.some(a => LEGACY_DNSKEY_ALGORITHMS.has(a));
  const flags = legacyAlgorithmPresent ? ['UNCALIBRATED_LEGACY_DNSKEY_ALGORITHM'] : [];

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
  scoreDnssecQuality,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_ANCHORED, PRIMARY_ISLAND, PRIMARY_UNSIGNED,
  MULT_SHA1_DS_DIGEST,
  LEGACY_DNSKEY_ALGORITHMS, SHA1_DIGEST_TYPE,
};
