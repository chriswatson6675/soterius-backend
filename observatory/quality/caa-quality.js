'use strict';

// CAA Quality Model — Category B · Signal 1 — reference implementation.
//
// Converts observed CAA facts (signal_facts_caa rows / caa-collector output) into an
// independent 0–100 Quality Score. This is signal quality ONLY; Trust Framework
// weighting is applied elsewhere and is intentionally independent of this score.
//
// The collector, parsing, resolver, schema and observation format are unchanged —
// this module only reads facts already produced.
//
// Implements the approved model CAA-QM-v1.0 EXACTLY:
//   design       SLG-070 (structure, resolution rules R1–R5, multipliers M1–M3)
//   calibration  SLG-071 (values; PROHIBITED and M3 left UNCALIBRATED)
//   verification SLG-072 (commissioning requirements CR-1 … CR-7)
//   commissioned SLG-073 (signal_quality_caa, migration 029; integrity 0 mismatches)
//
// ***  FROZEN as the production reference at the Governance Freeze — SLG-074.  ***
//
// CAA-QM-v1.0 is immutable. Its values, states, resolution rules and multipliers are never
// modified retrospectively (SLG-043 P9/P10). Any change — including calibrating PROHIBITED
// or M3, crediting an improvement, or fixing collector defect D-2 — requires a NEW VERSION
// (CAA-QM-v1.1 / v2.0), a NEW BASELINE, and a fresh pass of the SLG-043 lifecycle.
// Recalibration triggers are recorded at SLG-071 §8 (T1–T6) and SLG-074 §7.
//
// ── The model (SLG-070 §4/§5, SLG-071 §3) ────────────────────────────────────
//
// PRIMARY — the scope of certificate issuance the Relevant RRset constrains.
// RFC 8659 §4.3 partitions every request into exactly two disjoint classes
// (wildcard / non-wildcard); the Primary grades how many are constrained:
//
//   RESTRICTED            = 100  (2 of 2: an `issue` Property with >=1 authorising issuer)
//   WILDCARD_ONLY         =  50  (1 of 2: `issuewild` present, no `issue`; §4.3 leaves
//                                 non-wildcard issuance unconstrained)
//   UNCONSTRAINED         =   0  (0 of 2: no RRset, OR an RRset with no `issue` and no
//                                 `issuewild` — §4.2 "CAA does not restrict issuance").
//                                 A CONFIRMED floor (CAA absence is complete — SLG-065 §5).
//   PROHIBITED            = UNCALIBRATED  (`issue` present, zero authorising issuers).
//                                 n = 0 nationally. MUST NOT be silently scored (CR-3).
//   unobserved            = NOT SCORED (SLG-043 P1)
//
// SECONDARY MULTIPLIERS (reduce-only, ≤ 1.0, multiplicative):
//   M1 wildcard authorisation exceeds base   ×0.90  (§4.3 — `issuewild` wholly replaces
//                                                    `issue` for wildcard names)
//   M2 inoperative published element         ×0.95  (§4.2 override · §4.5 unrecognised tag
//                                                    · §4.4 non-URL iodef · §4.1 reserved bit)
//   M3 critical flag on an unrecognised tag  UNCALIBRATED (n = 1). Evaluated and FLAGGED,
//                                                    never applied as a factor (CR-4).
//
// ── Commissioning requirements honoured ──────────────────────────────────────
//
// CR-1  Reads `caa_records` ONLY (tags and values verbatim) and matches Property Tags
//       CASE-INSENSITIVELY. It NEVER reads caa_issue_count / caa_issuewild_count /
//       caa_iodef_count / caa_unknown_tag_count / caa_critical_count / caa_tags_present.
//       This makes the model IMMUNE to collector defect D-2 (SLG-067 §4.2: the collector's
//       tag matching is case-sensitive, contra RFC 8659 §4.1 "Matching of tags is case
//       insensitive"). `caa_records` preserves the tag verbatim, so folding here is correct.
//
// CR-2  The model is peer-independent but NOT row-independent (SLG-072 F1): RFC 8659 §3's
//       tree climb means an absent domain whose in-population ancestor publishes CAA is
//       governed by the ancestor's RRset. scoreCaaQuality() therefore takes a population
//       index; scorePopulation() is the population-level entry point.
//
// CR-3  PROHIBITED is OBSERVED but UNCALIBRATED. It returns scored:false with reason
//       'UNCALIBRATED_STATE_PROHIBITED' — distinct from the unobserved reason
//       'OBSERVATION_INCOMPLETE'. Callers MUST NOT persist it as a null score; the loader
//       halts. A domain entering this state requires a new model version (P10).
//
// CR-4  M3 is always evaluated and reported in `flags`, even though its factor is 1.00.

const QUALITY_VERSION = 'CAA-QM-v1.0';   // CR-7
const MODEL_ID        = 'CAA-QM-v1.0';

const PRIMARY_RESTRICTED    = 100;
const PRIMARY_WILDCARD_ONLY = 50;
const PRIMARY_UNCONSTRAINED = 0;         // confirmed floor

const MULT_WILDCARD_EXCEEDS_BASE = 0.90; // M1
const MULT_INOPERATIVE_ELEMENT   = 0.95; // M2
// M3 has no factor — uncalibrated (SLG-071 §5).

// RFC 8659 §4.2 ABNF:  issuer-domain-name = label *("." label)
//                      label = (ALPHA / DIGIT) *( *("-") (ALPHA / DIGIT) )
const LDH_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const ISSUER_DOMAIN_NAME = new RegExp(`^${LDH_LABEL}(?:\\.${LDH_LABEL})*$`);

// Property Tags with defined semantics (RFC 8659 §4.2-4.4, RFC 9495, CA/Browser Forum).
// Anything else is "undefined" and RFC 8659 §4.5 requires a CA to ignore it.
const DEFINED_TAGS    = new Set(['issue', 'issuewild', 'iodef', 'issuemail', 'issuevmc', 'contactemail', 'contactphone']);
// Tags RFC 8659 itself defines — the only ones on which the critical flag has NO effect (§4.5).
const RECOGNISED_TAGS = new Set(['issue', 'issuewild', 'iodef']);

// ── R1/R2 — §4.2 empty-equivalence and canonicalisation ──────────────────────
// The issuer-domain-name slot is everything before the first ';' (parameters), *WSP-trimmed.
const issuerSlot = (value) => String(value).split(';')[0].trim();

// §4.2: "An issue Property Tag where the issue-value does not match the ABNF grammar MUST be
// treated the same as one specifying an empty issuer-domain-name." A value therefore
// AUTHORISES only if its issuer-domain-name is non-empty AND ABNF-conformant.
// Note: a trailing dot yields a zero-length final label ⇒ NOT conformant (SLG-070 D4).
function isAuthorising(value) {
  const d = issuerSlot(value);
  return d !== '' && ISSUER_DOMAIN_NAME.test(d);
}
// LDH-Label admits ALPHA, so matching is case-insensitive.
const canonicalIssuer = (value) => issuerSlot(value).toLowerCase();

// CR-1 — Property Tags are matched case-insensitively, from the preserved evidence.
const tagOf = (record) => String(record.tag).toLowerCase();

const recordsWithTag = (records, tag) => records.filter(r => tagOf(r) === tag);
const authorisingSet = (records, tag) =>
  new Set(recordsWithTag(records, tag).filter(r => isAuthorising(r.value)).map(r => canonicalIssuer(r.value)));

const isUrl = (value) => /^[a-z][a-z0-9+.-]*:/i.test(String(value));

// ── R4 — RFC 8659 §3 inheritance resolution ──────────────────────────────────
// The Relevant RRset is found by climbing the name tree. Where a domain publishes nothing
// but an IN-POPULATION ancestor does, that ancestor's RRset is the child's Relevant RRset.
// Returns { rrset: <facts row with caa_records> | null, source: 'self'|'ancestor'|'none',
//           inheritedFrom: <domain>|null }.
function resolveRelevantRRset(facts, population) {
  if (facts.dns_caa_present === true)  return { rrset: facts, source: 'self',   inheritedFrom: null };
  if (facts.dns_caa_present === null)  return { rrset: null,  source: 'none',   inheritedFrom: null };
  let best = null;
  for (const [domain, other] of population) {
    if (domain === facts.domain) continue;
    if (other.dns_caa_present !== true) continue;
    if (!facts.domain.endsWith('.' + domain)) continue;
    if (!best || domain.length > best.length) best = domain;   // nearest ancestor
  }
  return best
    ? { rrset: population.get(best), source: 'ancestor', inheritedFrom: best }
    : { rrset: null, source: 'none', inheritedFrom: null };
}

// ── Primary state + multiplier conditions over a Relevant RRset ──────────────
function classify(rrset) {
  if (!rrset) return { state: 'UNCONSTRAINED', m1: false, m2: false, m3: false };

  const records = rrset.caa_records || [];
  const issueRecords     = recordsWithTag(records, 'issue');
  const issuewildRecords = recordsWithTag(records, 'issuewild');
  const issueAuth        = authorisingSet(records, 'issue');
  const issuewildAuth    = authorisingSet(records, 'issuewild');

  let state;
  if (issueRecords.length === 0 && issuewildRecords.length === 0) state = 'UNCONSTRAINED'; // §4.2
  else if (issueRecords.length === 0)                             state = 'WILDCARD_ONLY'; // §4.3
  else if (issueAuth.size === 0)                                  state = 'PROHIBITED';    // §4.2 (uncalibrated)
  else                                                            state = 'RESTRICTED';

  // M1 — the wildcard authorisation set contains an issuer the base set does not (§4.3).
  const m1 = issueAuth.size > 0 && issuewildAuth.size > 0 &&
             [...issuewildAuth].some(i => !issueAuth.has(i));

  // M2 — the RRset carries >=1 element the RFC requires to be ignored, or that grants nothing.
  const m2 =
    (issueRecords.some(r => !isAuthorising(r.value))     && issueAuth.size > 0)      || // (a) §4.2 override
    (issuewildRecords.some(r => !isAuthorising(r.value)) && issuewildAuth.size > 0)  || // (a) via §4.3
    records.some(r => !DEFINED_TAGS.has(tagOf(r)))                                   || // (b) §4.5
    records.some(r => tagOf(r) === 'iodef' && !isUrl(r.value))                       || // (c) §4.4
    records.some(r => r.flags !== 0 && r.flags !== 128);                                // (d) §4.1

  // M3 — critical flag on an unrecognised Property Tag (§4.5). Evaluated, never applied.
  const m3 = records.some(r => (r.flags & 128) !== 0 && !RECOGNISED_TAGS.has(tagOf(r)));

  return { state, m1, m2, m3 };
}

const PRIMARY_OF = {
  RESTRICTED:    PRIMARY_RESTRICTED,
  WILDCARD_ONLY: PRIMARY_WILDCARD_ONLY,
  UNCONSTRAINED: PRIMARY_UNCONSTRAINED,
};

// scoreCaaQuality(facts, population) — facts = a signal_facts_caa row (or collector output
// with `domain`); population = Map<domain, facts> for R4 resolution (CR-2).
// →  { scored, reason?, score, primary, primaryLabel, applied[], flags[], source, inheritedFrom }
function scoreCaaQuality(facts, population = new Map()) {
  // R5 — unobserved is never scored and never imputed (P1).
  if (facts.dns_caa_present == null) {
    return { scored: false, reason: 'OBSERVATION_INCOMPLETE', score: null,
             collectionError: facts.caa_collection_error ?? null };
  }

  const { rrset, source, inheritedFrom } = resolveRelevantRRset(facts, population);
  const { state, m1, m2, m3 } = classify(rrset);

  // CR-3 — PROHIBITED is OBSERVED but UNCALIBRATED. Never silently null; the caller must halt.
  if (state === 'PROHIBITED') {
    return { scored: false, reason: 'UNCALIBRATED_STATE_PROHIBITED', score: null,
             primaryLabel: 'PROHIBITED', source, inheritedFrom,
             flags: m3 ? ['M3_CRITICAL_UNRECOGNISED_TAG'] : [] };
  }

  const primary = PRIMARY_OF[state];
  const applied = [];
  let product = 1;

  if (m1) { applied.push({ name: 'wildcard authorisation exceeds base', factor: MULT_WILDCARD_EXCEEDS_BASE }); product *= MULT_WILDCARD_EXCEEDS_BASE; }
  if (m2) { applied.push({ name: 'inoperative published element',       factor: MULT_INOPERATIVE_ELEMENT   }); product *= MULT_INOPERATIVE_ELEMENT; }

  // CR-4 — M3 is reported, never applied (uncalibrated).
  const flags = m3 ? ['M3_CRITICAL_UNRECOGNISED_TAG'] : [];

  return {
    scored: true,
    score: Math.round(primary * product * 100) / 100,
    primary,
    primaryLabel: state,
    applied,
    flags,
    source,
    inheritedFrom,
  };
}

// Population-level entry point (CR-2). rows = iterable of signal_facts_caa rows.
// Returns Map<domain, result-of-scoreCaaQuality>.
function scorePopulation(rows) {
  const population = new Map();
  for (const r of rows) population.set(r.domain, r);
  const out = new Map();
  for (const r of rows) out.set(r.domain, scoreCaaQuality(r, population));
  return out;
}

module.exports = {
  scoreCaaQuality, scorePopulation, resolveRelevantRRset, classify,
  isAuthorising, canonicalIssuer, tagOf, ISSUER_DOMAIN_NAME,
  QUALITY_VERSION, MODEL_ID,
  PRIMARY_RESTRICTED, PRIMARY_WILDCARD_ONLY, PRIMARY_UNCONSTRAINED,
  MULT_WILDCARD_EXCEEDS_BASE, MULT_INOPERATIVE_ELEMENT,
  DEFINED_TAGS, RECOGNISED_TAGS,
};
