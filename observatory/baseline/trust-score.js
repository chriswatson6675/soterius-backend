'use strict';

/*
 * Trust Score engine — TS-RUBRIC-v1.0
 * ===================================
 *
 * Pure, deterministic implementation of the Trust Score model defined in the
 * Signal Lab governance framework (SLG-030..SLG-038). It is a DERIVATION over
 * immutable Observatory observations — it never collects, never mutates
 * evidence, and produces byte-identical output for identical input.
 *
 *   TrustScore = clamp(round_half_up( (E / A) * 999 ), 1, 999)
 *
 *   E (earned)     = Σ earned points over signals that are OBSERVED
 *   A (attainable) = Σ signal weight over signals that are OBSERVED
 *                    − 18 (reserved Security-Headers strength sub-budget,
 *                          NON_OBSERVED platform-wide until a strength layer ships)
 *   if A < 500  →  INSUFFICIENT_OBSERVATION (score 000, not computed)
 *
 * Two nulls (SLG-035 §2):
 *   NON_OBSERVED   — state could not be determined (transient failure, no web
 *                    endpoint, DKIM not-detected, D/E/H not collected). Excluded
 *                    from BOTH E and A. Never a penalty, never a finding.
 *   OBSERVED_ABSENT— determined absent (e.g. no SPF record on a domain that
 *                    resolves). earned = 0, still counts in A. Raises a finding.
 *
 * Category weights (positive-weight sum = 999; TLS-RPT is DORMANT, weight 0):
 *   A Email 270 · D TLS/Cert 210 · B Domain 165 · C Transparency 150 ·
 *   E Ownership 111 · H Governance 93
 *
 * National Baseline 001 collects Categories A, B, C only; D/E/H are passed as
 * NON_OBSERVED. This is faithful to the rubric — the model is NOT extended.
 * A consequence to read in the report: max attainable in Core-only mode is 567,
 * so any org missing DKIM (−70) or a web endpoint (−55 headers / −35 s.txt)
 * falls under the A≥500 floor and scores INSUFFICIENT. That is the honest,
 * spec-compliant outcome; D/E/H are the Founder's designated enrichment phases.
 *
 * Field names and value domains below were verified against the live Supabase
 * schema on 2026-07-07 (not taken from the docs, which flagged naming drift).
 */

const RUBRIC = 'TS-RUBRIC-v1.0';
const BASE_BUDGET = 999;               // Σ positive weights (TLS-RPT excluded)
const RESERVED_HEADER_STRENGTH = 18;   // reserved sub-budget of Security Headers' 55
const SCOREABLE_FLOOR = 500;           // A < 500 → INSUFFICIENT_OBSERVATION

// Signal weights, by canonical signal id.
const WEIGHTS = {
  // A — Email Trust (270)
  DMARC: 120, SPF: 80, DKIM: 70,
  // B — Domain Trust (165)
  DNSSEC: 100, CAA: 65,
  // C — Control Transparency (150); TLS-RPT dormant (0)
  SECURITY_HEADERS: 55, MTA_STS: 60, SECURITY_TXT: 35,
  // D — TLS & Certificate (210)  [not collected in Core baseline]
  CERTIFICATE: 110, TLS: 100,
  // E — Ownership Trust (111)    [not collected in Core baseline]
  DOMAIN_REGISTRATION: 111,
  // H — Governance & Accountability (93) [not collected in Core baseline]
  TRANSFER_SAFEGUARD: 36, RETENTION_TRANSPARENCY: 30, DISCLOSURE_CURRENCY: 27,
};

const CATEGORY_OF = {
  DMARC: 'A', SPF: 'A', DKIM: 'A',
  DNSSEC: 'B', CAA: 'B',
  SECURITY_HEADERS: 'C', MTA_STS: 'C', SECURITY_TXT: 'C',
  CERTIFICATE: 'D', TLS: 'D',
  DOMAIN_REGISTRATION: 'E',
  TRANSFER_SAFEGUARD: 'H', RETENTION_TRANSPARENCY: 'H', DISCLOSURE_CURRENCY: 'H',
};

// Provisional reporting overlay (SLG-038 §1) — NOT part of the rubric, scaled
// from the legacy model, pending benchmark-layer recalibration. Reported for
// orientation only; never treated as canonical.
function provisionalBand(score, label) {
  if (label === 'INSUFFICIENT_OBSERVATION') return 'Insufficient';
  if (score >= 900) return 'Excellent';
  if (score >= 750) return 'Good';
  if (score >= 600) return 'Moderate';
  if (score >= 400) return 'High';
  return 'Critical';
}

const NON_OBSERVED = (id) => ({ id, category: CATEGORY_OF[id], weight: WEIGHTS[id], observed: false, earned: 0 });
const OBSERVED = (id, earned) => ({ id, category: CATEGORY_OF[id], weight: WEIGHTS[id], observed: true, earned });

// A DNS/collection error string that means "could not determine" → NON_OBSERVED.
const hasError = (v) => v !== null && v !== undefined && String(v).trim() !== '';

// ── Category A ────────────────────────────────────────────────────────────────

function scoreSpf(row) {
  if (!row || hasError(row.spf_collection_error)) return NON_OBSERVED('SPF');
  if (!row.spf_present || row.spf_mechanism === '+all') return OBSERVED('SPF', 0);
  let base;
  switch (row.spf_mechanism) {
    case '?all': base = 12; break;
    case '~all': base = 44; break;
    case '-all': base = 72; break;
    default:     base = 0;         // present but no recognised all-qualifier
  }
  let earned = base;
  const wellFormed = row.spf_parse_success === true
    && (row.spf_lookup_count === null || row.spf_lookup_count <= 10)
    && row.spf_multiple_records !== true;
  if (base > 0 && wellFormed) earned += 8;
  return OBSERVED('SPF', earned);
}

function scoreDmarc(row) {
  if (!row || hasError(row.dmarc_collection_error)) return NON_OBSERVED('DMARC');
  if (!row.dmarc_present) return OBSERVED('DMARC', 0);
  let earned;
  switch (row.dmarc_policy) {
    case 'reject':     earned = 108; break;
    case 'quarantine': earned = 75;  break;
    case 'none':       earned = 18;  break;
    default:           earned = 0;   break; // present but unparseable policy
  }
  if (earned > 0) {
    // +full rollout (pct 100 or absent = 100)
    if (row.dmarc_pct === null || row.dmarc_pct === undefined || row.dmarc_pct === 100) earned += 6;
    // +reporting (rua present, available from p=none up)
    if ((row.dmarc_rua_count || 0) > 0) earned += 4;
    // +subdomain not weaker than policy (absent sp inherits p → not weaker)
    const rank = { none: 1, quarantine: 2, reject: 3 };
    const sp = row.dmarc_subdomain_policy;
    const spRank = sp == null ? rank[row.dmarc_policy] : rank[sp];
    if (spRank !== undefined && spRank >= rank[row.dmarc_policy]) earned += 2;
  }
  return OBSERVED('DMARC', Math.min(earned, WEIGHTS.DMARC));
}

// dkim = { row, keys: [ {key_type, key_bits, public_key_present}, ... ] }
function scoreDkim(dkim) {
  const row = dkim && dkim.row;
  if (!row) return NON_OBSERVED('DKIM');
  const status = row.dkim_collection_status;
  // NOT_DETECTED (can't prove absence) and transient DNS failures → NON_OBSERVED.
  if (status === 'NOT_DETECTED' || hasError(status)) return NON_OBSERVED('DKIM');
  if (!row.dkim_present) return NON_OBSERVED('DKIM');
  const keys = dkim.keys || [];
  const isStrong = (k) => k.public_key_present === true
    && (k.key_type === 'ed25519' || (k.key_type === 'rsa' && (k.key_bits || 0) >= 2048));
  const strongKeys = keys.filter(isStrong);
  if (keys.length === 0) return OBSERVED('DKIM', 30); // present but key not recoverable → weak
  let earned = strongKeys.length > 0 ? 62 : 30;
  if (strongKeys.length > 0 && (row.dkim_record_count || 0) >= 2) earned += 8; // rotation
  return OBSERVED('DKIM', Math.min(earned, WEIGHTS.DKIM));
}

// ── Category B ────────────────────────────────────────────────────────────────

function scoreDnssec(row) {
  if (!row || hasError(row.ds_collection_error)) return NON_OBSERVED('DNSSEC');
  const ds = row.dns_ds_present === true;
  const dnskey = row.dns_dnskey_present === true;
  let earned;
  if (ds && dnskey) earned = 85;
  else if (dnskey && !ds) earned = 20;   // island (unanchored)
  else earned = 0;                        // unsigned
  if (earned > 0) {
    const algos = [...(row.ds_algorithms || []), ...(row.dnskey_algorithms || [])];
    if (algos.some((a) => [13, 14, 15].includes(Number(a)))) earned += 15;
  }
  return OBSERVED('DNSSEC', Math.min(earned, WEIGHTS.DNSSEC));
}

function scoreCaa(row) {
  if (!row || hasError(row.caa_collection_error)) return NON_OBSERVED('CAA');
  if (!row.dns_caa_present) return OBSERVED('CAA', 0);
  let earned = 0;
  if ((row.caa_issue_count || 0) >= 1) earned += 45;
  if (earned > 0) {
    if ((row.caa_issuewild_count || 0) >= 1) earned += 12;
    if ((row.caa_iodef_count || 0) >= 1 || (row.caa_critical_count || 0) >= 1) earned += 8;
  }
  return OBSERVED('CAA', Math.min(earned, WEIGHTS.CAA));
}

// ── Category C ────────────────────────────────────────────────────────────────

function scoreSecurityHeaders(row) {
  // No web endpoint / transient → NON_OBSERVED (the whole 55-pt weight drops out).
  if (!row || row.endpoint_state !== 'RESPONSE_OBSERVED') return NON_OBSERVED('SECURITY_HEADERS');
  const inv = row.header_inventory || {};
  const present = (k) => inv[k] && inv[k].present === true;
  let earned = 0;
  if (present('content_security_policy'))   earned += 12;
  if (present('strict_transport_security')) earned += 9;
  if (present('x_frame_options'))           earned += 6;
  if (present('x_content_type_options'))    earned += 4;
  if (present('referrer_policy'))           earned += 2;
  if (present('permissions_policy'))        earned += 1;
  if (present('cross_origin_opener_policy') || present('cross_origin_embedder_policy') || present('cross_origin_resource_policy')) earned += 1;
  if (!present('server') && !present('x_powered_by')) earned += 2; // no info leak
  return OBSERVED('SECURITY_HEADERS', earned); // max 37 (18-pt strength reserved)
}

function scoreMtaSts(row) {
  if (!row || hasError(row.dns_collection_error)) return NON_OBSERVED('MTA_STS');
  if (!row.dns_sts_present) return OBSERVED('MTA_STS', 0);
  let earned;
  if (row.policy_present === true && row.policy_mode === 'enforce') earned = 52;
  else if (row.policy_present === true && row.policy_mode === 'testing') earned = 24;
  else earned = 8; // DNS record present, policy absent / non-enforcing
  if (earned >= 24 && row.policy_tls_valid === true && (row.policy_max_age || 0) >= 604800) earned += 8;
  return OBSERVED('MTA_STS', Math.min(earned, WEIGHTS.MTA_STS));
}

function scoreSecurityTxt(row) {
  if (!row || row.file_state == null || row.file_state === 'INDETERMINATE') return NON_OBSERVED('SECURITY_TXT');
  let earned;
  switch (row.file_state) {
    case 'PRESENT_CANONICAL':
    case 'PRESENT_BOTH':        earned = 28; break;
    case 'PRESENT_LEGACY_ONLY': earned = 18; break;
    case 'ABSENT':              earned = 0;  break;
    default:                    return NON_OBSERVED('SECURITY_TXT');
  }
  if (earned > 0) {
    const contact = row.canonical_parse && Array.isArray(row.canonical_parse.contact) ? row.canonical_parse.contact : [];
    if (contact.length >= 1) earned += 7;
  }
  return OBSERVED('SECURITY_TXT', Math.min(earned, WEIGHTS.SECURITY_TXT));
}

// ── Aggregation ───────────────────────────────────────────────────────────────

/*
 * facts: {
 *   spf, dmarc, dnssec, caa, mtasts, securityheaders, securitytxt : raw rows,
 *   dkim: { row, keys: [] },
 *   // Category D/E/H rows may be provided; in Core baseline they are omitted
 *   // and default to NON_OBSERVED.
 * }
 */
function scoreTrust(facts = {}) {
  const signals = [
    scoreSpf(facts.spf),
    scoreDmarc(facts.dmarc),
    scoreDkim(facts.dkim),
    scoreDnssec(facts.dnssec),
    scoreCaa(facts.caa),
    scoreSecurityHeaders(facts.securityheaders),
    scoreMtaSts(facts.mtasts),
    scoreSecurityTxt(facts.securitytxt),
    // D / E / H — not collected in Core baseline → NON_OBSERVED (documents the gap in completeness).
    NON_OBSERVED('CERTIFICATE'),
    NON_OBSERVED('TLS'),
    NON_OBSERVED('DOMAIN_REGISTRATION'),
    NON_OBSERVED('TRANSFER_SAFEGUARD'),
    NON_OBSERVED('RETENTION_TRANSPARENCY'),
    NON_OBSERVED('DISCLOSURE_CURRENCY'),
  ];

  const headersObserved = signals.find((s) => s.id === 'SECURITY_HEADERS').observed;
  const reserved = headersObserved ? RESERVED_HEADER_STRENGTH : 0;

  let A = 0, E = 0;
  for (const s of signals) {
    if (!s.observed) continue;
    A += s.weight;
    E += s.earned;
  }
  A -= reserved;

  const completeness = A / BASE_BUDGET;
  const categories = {};
  for (const cat of ['A', 'B', 'C', 'D', 'E', 'H']) categories[cat] = { earned: 0, attainable: 0 };
  for (const s of signals) {
    if (!s.observed) continue;
    categories[s.category].earned += s.earned;
    categories[s.category].attainable += s.weight;
  }
  if (headersObserved) categories.C.attainable -= reserved;

  let score, label;
  if (A < SCOREABLE_FLOOR) {
    score = 0;
    label = 'INSUFFICIENT_OBSERVATION';
  } else {
    const raw = (E / A) * BASE_BUDGET;
    score = Math.min(BASE_BUDGET, Math.max(1, Math.round(raw)));
    label = 'SCORED';
  }

  const observedSignalCount = signals.filter((s) => s.observed).length;
  const coreObserved = ['SPF', 'DMARC', 'DKIM', 'DNSSEC', 'CAA', 'SECURITY_HEADERS', 'MTA_STS', 'SECURITY_TXT']
    .every((id) => signals.find((s) => s.id === id).observed);

  return {
    rubric: RUBRIC,
    score,
    label,
    band: provisionalBand(score, label),
    earned: E,
    attainable: A,
    completeness: Number(completeness.toFixed(4)),
    coreComplete: coreObserved,          // all 8 scored Core (A/B/C) signals OBSERVED
    observedSignalCount,
    categories,
    signals: signals.map((s) => ({ id: s.id, category: s.category, weight: s.weight, observed: s.observed, earned: s.earned })),
  };
}

module.exports = {
  RUBRIC, BASE_BUDGET, RESERVED_HEADER_STRENGTH, SCOREABLE_FLOOR, WEIGHTS, CATEGORY_OF,
  scoreTrust, provisionalBand,
  scoreSpf, scoreDmarc, scoreDkim, scoreDnssec, scoreCaa, scoreSecurityHeaders, scoreMtaSts, scoreSecurityTxt,
};
