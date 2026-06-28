'use strict';

// resolve-anchor.js — firm → Companies House company_number resolution.
//
// THIS IS A RUNNER PRE-STEP, NOT OBSERVATION. The IF-001 cohort identifies firms
// by name + domain; the collector anchors on a company_number (endpoint-map EO-01).
// Something must turn a firm into an anchor. The collector itself must NOT do this
// (CCS §1.2 N4/N10: it does not auto-cross an entity boundary or resolve truth), so
// resolution lives here, upstream of observe(), exactly as the registrar runner
// derives its anchors from an upstream run.
//
// Discipline (so the corpus stays authoritative):
//   - Resolution output (a company_number) is ONLY an anchor. It is never folded
//     into the evidence asset as an observed fact. The observed evidence remains
//     exactly what observe() emits once anchored.
//   - We resolve ONLY on a confident, unambiguous match. A weak or ambiguous match
//     is recorded as a resolution non-observation (Unknown ≠ Absent), never guessed.
//   - Every resolution carries its own provenance (query, candidates, decision).
//
// Mechanism: the Public Data API search surface, GET /search/companies?q={name}
// (ESD-COMPHOUSE-001 §4 — same PDA surface, same auth, same rate budget). This
// endpoint is intentionally NOT in endpoint-map.js: that map encodes EVIDENCE
// object → endpoint (what the collector observes). Search is not an evidence
// object; it is anchor discovery, and belongs to the runner layer.

const PDA = 'https://api.company-information.service.gov.uk';

const RESOLUTION = Object.freeze({
  RESOLVED: 'RESOLVED',                       // confident unambiguous company_number
  AMBIGUOUS: 'AMBIGUOUS',                      // multiple equally-good candidates — refused
  NOT_FOUND: 'NOT_FOUND',                      // search returned nothing usable
  SEARCH_UNAVAILABLE: 'SEARCH_UNAVAILABLE',    // surface error (resumable)
});

// Legal-form suffixes stripped before comparison (compared separately, not as name).
const SUFFIXES = [
  'LIMITED', 'LTD', 'LLP', 'PLC', 'LP', 'L.P', 'CIC', 'CIO',
  'PUBLIC LIMITED COMPANY', 'LIMITED LIABILITY PARTNERSHIP',
  'COMPANY', 'CO', 'INCORPORATED', 'INC', 'CORPORATION', 'CORP',
];

const ACTIVE_STATUSES = new Set(['active', 'open']);

/**
 * Resolve one firm to a Companies House company_number.
 *
 * @param {{firm_name:string, domain?:string, id?:string}} firm
 * @param {Object} deps
 * @param {string} deps.apiKey
 * @param {Object} deps.client      - ch-client (getJson); injectable for tests
 * @param {Object} [deps.rateManager]
 * @param {function} [deps.now]      - () => ISO string
 * @returns {Promise<ResolutionRecord>}
 */
async function resolveCompanyNumber(firm, deps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const observedAt = now();
  const q = String(firm.firm_name ?? '').trim();
  const uri = `${PDA}/search/companies?q=${encodeURIComponent(q)}&items_per_page=20`;

  const res = await deps.client.getJson(uri, { apiKey: deps.apiKey, rateManager: deps.rateManager });

  const base = {
    firm: { id: firm.id ?? null, firm_name: firm.firm_name, domain: firm.domain ?? null },
    query: q,
    provenance: { observedAt, sourceSurface: 'PDA', requestUri: uri, endpoint: 'GET /search/companies' },
  };

  if (res.errorType !== 'NONE') {
    return { ...base, status: RESOLUTION.SEARCH_UNAVAILABLE, httpStatus: res.httpStatus ?? null,
      reason: res.errorType, companyNumber: null, candidates: [] };
  }

  const items = Array.isArray(res.body?.items) ? res.body.items : [];
  const candidates = items.map((it) => ({
    company_number: it.company_number ?? null,
    title: it.title ?? null,
    status: it.company_status ?? null,
    type: it.company_type ?? null,
    address_snippet: it.address_snippet ?? null,
  })).filter((c) => c.company_number);

  if (candidates.length === 0) {
    return { ...base, status: RESOLUTION.NOT_FOUND, companyNumber: null, candidates: [],
      reason: 'search returned no companies' };
  }

  const wantName = normaliseName(firm.firm_name);
  const wantSuffix = legalSuffix(firm.firm_name);

  // Score each candidate against the firm name. Exact normalised-name match is the
  // only thing that earns RESOLVED; legal form agreement and active status break ties.
  const scored = candidates.map((c) => {
    const candName = normaliseName(c.title);
    const exact = candName === wantName && wantName.length > 0;
    const candSuffix = legalSuffix(c.title);
    return {
      candidate: c,
      exact,
      suffixMatch: wantSuffix && candSuffix === wantSuffix,
      active: ACTIVE_STATUSES.has(String(c.status ?? '').toLowerCase()),
    };
  });

  const exactMatches = scored.filter((s) => s.exact);

  // Confident resolution: exactly one exact-name match (or, among several exact-name
  // matches, exactly one that is active) — anything else is refused as ambiguous.
  let chosen = null;
  let confidence = null;
  if (exactMatches.length === 1) {
    chosen = exactMatches[0];
    confidence = chosen.suffixMatch ? 'high' : 'medium';
  } else if (exactMatches.length > 1) {
    const activeExact = exactMatches.filter((s) => s.active);
    if (activeExact.length === 1) { chosen = activeExact[0]; confidence = 'medium'; }
  }

  if (!chosen) {
    return {
      ...base,
      status: exactMatches.length > 1 ? RESOLUTION.AMBIGUOUS : RESOLUTION.NOT_FOUND,
      companyNumber: null,
      candidates: candidates.slice(0, 10),
      reason: exactMatches.length > 1
        ? `${exactMatches.length} exact-name matches, no single active match`
        : 'no exact-name match among candidates',
    };
  }

  return {
    ...base,
    status: RESOLUTION.RESOLVED,
    companyNumber: chosen.candidate.company_number,
    matchedTitle: chosen.candidate.title,
    matchedStatus: chosen.candidate.status,
    confidence,
    candidates: candidates.slice(0, 10),
    reason: `exact name match (${confidence})`,
  };
}

// ── name normalisation ───────────────────────────────────────────────────────────

function normaliseName(name) {
  if (!name) return '';
  let s = String(name).toUpperCase();
  s = s.replace(/&/g, ' AND ');
  s = s.replace(/[^A-Z0-9 ]+/g, ' ');          // drop punctuation
  s = s.replace(/\s+/g, ' ').trim();
  // strip a trailing legal-form suffix (compared separately)
  for (const suf of SUFFIXES) {
    if (s === suf) continue;
    if (s.endsWith(' ' + suf)) { s = s.slice(0, -(suf.length + 1)).trim(); break; }
  }
  return s.replace(/\s+/g, ' ').trim();
}

function legalSuffix(name) {
  if (!name) return null;
  const s = String(name).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const suf of SUFFIXES) {
    if (s === suf || s.endsWith(' ' + suf)) return suf;
  }
  return null;
}

module.exports = {
  resolveCompanyNumber,
  RESOLUTION,
  // exported for tests
  normaliseName,
  legalSuffix,
};
