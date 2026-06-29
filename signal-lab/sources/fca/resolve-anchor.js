'use strict';

// resolve-anchor.js — resolve a collection anchor (FRN) for the FCA collector.
//
// Reference Collector v0.1 — PHASE 3 (IMP-FCA-001 §3; CCS-FCA-001 §5.1 discovery).
//
// Resolves an input to a definite FRN, or reports an explicit, non-guessing
// failure. It accepts an FRN directly, or resolves a firm NAME to an FRN via the
// FS Register `/Search` discovery surface. It performs NO fuzzy matching and NO
// identity inference: it resolves only on (a) a single search result, or (b) an
// exact (case-insensitive, postcode-suffix-stripped) NAME equality among results.
// Anything else is reported as AMBIGUOUS with the candidates recorded but NOT
// chosen. Clone / unauthorised-firm warnings (EOI-FCA-001 §6.1; a watch item) are
// recorded as warnings, never resolved to.
//
// Search is DISCOVERY, not evidence (CCS-FCA-001 §5.1): this module finds an
// identifier; it does not observe, preserve, or traverse beyond the requested
// anchor [CR-FCA-13].
//
// Authority: CCS-FCA-001 §5.1; ESD-FCA-001 §4.5; EOI-FCA-001 §6.1.

const { buildUrl, getJson } = require('./fca-client');

const RESOLUTION = Object.freeze({
  DIRECT: 'direct',       // input was already an FRN
  RESOLVED: 'resolved',   // name resolved to exactly one FRN
  AMBIGUOUS: 'ambiguous', // multiple candidates; NOT chosen
  NOT_FOUND: 'not-found', // no candidates
  ERROR: 'error',         // transport / config failure (non-observation)
});

const FRN_PATTERN = /^\d{4,8}$/;

/** Strip the FCA display suffixes "(Postcode: …)" / "(clone …)" and normalise for equality. */
function normaliseName(name) {
  return String(name ?? '')
    .replace(/\s*\((?:Postcode|clone)[^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isCloneWarning(hit) {
  const name = String(hit && hit.Name || '');
  return /clone|not authorised|unauthorised/i.test(name) || !(hit && hit['Reference Number']);
}

function briefCandidate(hit) {
  return {
    referenceNumber: hit['Reference Number'] ?? null,
    name: hit.Name ?? null,
    status: hit.Status ?? null,
    type: hit['Type of business or Individual'] ?? null,
  };
}

function result(resolution, anchor, extra) {
  return { resolution, anchor: anchor ?? null, ok: resolution === RESOLUTION.DIRECT || resolution === RESOLUTION.RESOLVED, ...extra };
}

/**
 * Resolve an input to an FRN. Never rejects.
 *
 * @param {string} input - an FRN or a firm name
 * @param {Object} opts
 * @param {Object} opts.config - { baseUrl, email, apiKey }
 * @param {function} [opts._fetch] - injectable transport (tests)
 * @returns {Promise<Object>} a deterministic resolution result
 */
async function resolveAnchor(input, opts = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return result(RESOLUTION.NOT_FOUND, null, { input: raw, reason: 'empty input' });

  // Direct FRN — no search needed.
  if (FRN_PATTERN.test(raw)) return result(RESOLUTION.DIRECT, raw, { input: raw, method: 'direct' });

  const { config = {}, _fetch } = opts;
  const url = buildUrl(config.baseUrl, `/Search?q=${encodeURIComponent(raw)}&type=firm`);
  const res = await getJson(url, { email: config.email, apiKey: config.apiKey, _fetch });

  if (res.errorType !== 'NONE') {
    return result(RESOLUTION.ERROR, null, { input: raw, reason: `transport ${res.errorType}`, fsrStatus: res.fsrStatus });
  }

  const data = Array.isArray(res.body && res.body.Data) ? res.body.Data : [];
  const cloneWarnings = data.filter(isCloneWarning).map(briefCandidate);
  const candidates = data.filter((h) => h && h['Reference Number'] && !isCloneWarning(h));

  if (candidates.length === 0) {
    return result(RESOLUTION.NOT_FOUND, null, { input: raw, fsrStatus: res.fsrStatus, candidateCount: 0, cloneWarnings });
  }
  if (candidates.length === 1) {
    return result(RESOLUTION.RESOLVED, candidates[0]['Reference Number'], { input: raw, method: 'search-single', name: candidates[0].Name, cloneWarnings });
  }

  // Multiple results: resolve ONLY on exact normalised-name equality (deterministic,
  // not fuzzy). Otherwise report ambiguity without choosing.
  const exact = candidates.filter((c) => normaliseName(c.Name) === normaliseName(raw));
  if (exact.length === 1) {
    return result(RESOLUTION.RESOLVED, exact[0]['Reference Number'], { input: raw, method: 'search-exact-name', name: exact[0].Name, cloneWarnings });
  }

  return result(RESOLUTION.AMBIGUOUS, null, {
    input: raw,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 20).map(briefCandidate),
    cloneWarnings,
  });
}

module.exports = { resolveAnchor, RESOLUTION, normaliseName, FRN_PATTERN };
