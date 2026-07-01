'use strict';

// fca-match.js — deterministic FCA-register name matching (pure; no I/O).
//
// Population Acquisition Layer. Encodes the matching logic VALIDATED by the
// Companies House → FCA proof of concept: normalise a name, then decide a single
// high-confidence match by EXACT normalised equality against FCA search results.
// No fuzzy matching, no heuristics beyond deterministic normalisation.
//
// CRITICAL (PoC finding): the FCA Search renders firm names with an appended
// "(Postcode: …)" annotation — e.g. "Hugh James Consultancy Ltd (Postcode: BH1 1JD)".
// Without stripping that parenthetical the exact-match silently fails on genuine hits
// (the PoC collapsed from 31.2% to 0.2% matches). normaliseName() removes it.
//
// Outcome semantics (PoC):
//   - exactly one distinct FRN whose normalised name equals the candidate → MATCH
//   - zero                                                                → NO_MATCH
//   - more than one distinct FRN with the same normalised name            → AMBIGUOUS
//
// This module decides the NAME match and returns the matched entry's FCA status
// verbatim. It does NOT decide authorisation (a later, separate gate), perform the
// live FCA search (the orchestration step), or persist anything.

/**
 * Deterministic name normalisation: uppercase, & → AND, strip FCA-added
 * parentheticals (incl. "(Postcode: …)"), drop punctuation, drop trailing legal
 * forms, collapse whitespace. Pure.
 */
function normaliseName(name) {
  return String(name || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/\([^)]*\)/g, ' ')                       // strip "(Postcode: BH1 1JD)" etc. — PoC fix
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\b(LIMITED|LIMTED|LTD|PLC|LLP|LP)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const OUTCOME = Object.freeze({ MATCH: 'match', NO_MATCH: 'no_match', AMBIGUOUS: 'ambiguous' });

/**
 * Decide a deterministic match between a candidate company name and FCA search hits.
 * @param {string} companyName - the Companies House candidate name
 * @param {Array<{frn:(string|number), name:string, status?:string}>} results - FCA search hits
 * @returns {{ outcome:string, frn?:string, name?:string, status?:(string|null), candidates?:string[] }}
 */
function decideMatch(companyName, results) {
  const target = normaliseName(companyName);
  if (!target) return { outcome: OUTCOME.NO_MATCH };

  const exact = new Map();                            // frn → { frn, name, status }
  for (const r of (results || [])) {
    if (!r || r.frn == null || r.name == null) continue;
    if (normaliseName(r.name) === target) {
      exact.set(String(r.frn), { frn: String(r.frn), name: r.name, status: r.status ?? null });
    }
  }

  if (exact.size === 0) return { outcome: OUTCOME.NO_MATCH };
  if (exact.size > 1) return { outcome: OUTCOME.AMBIGUOUS, candidates: [...exact.keys()] };
  return { outcome: OUTCOME.MATCH, ...[...exact.values()][0] };
}

module.exports = { normaliseName, decideMatch, OUTCOME };
