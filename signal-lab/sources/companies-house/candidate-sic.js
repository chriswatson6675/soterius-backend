'use strict';

// candidate-sic.js — approved financial SIC code set for FCA candidate acquisition.
//
// Population Acquisition Layer — the versioned, deterministic DECISION INPUT that
// governs which Companies House companies become FCA *candidates*. Pure data + a
// membership predicate: NO I/O, NO FCA interaction, NO enrichment, NO name/fuzzy
// matching, NO category derivation. It only answers "does this company carry an
// approved financial SIC code?".
//
// Companies House stores SIC as 5-digit condensed codes (SIC 2007), up to four per
// company; the bulk Free Company Data Product renders them as "66190 - Activities…"
// and the API as bare "66190". A company qualifies iff ANY of its SIC codes is in the
// approved set.
//
// The set is the core INCLUDE list from the Stage 1 SIC Code Review (SIC 2007
// Section K — high precision + recall for FCA authorisation). High-false-positive
// codes are deliberately EXCLUDED (e.g. 64205 holding companies, 64110 central
// banking, 65300 pension funding, 64301-64306 trusts/funds). Pinning the set here,
// with a version, makes the Candidate Dataset reproducible: same snapshot + same
// SIC-set version → identical candidates. Widening recall = bump the version and add
// codes here; the engine and acquisition process do not change.

const SIC_SET_VERSION = 'fca-candidate-sic/1.0.0';

// CH 5-digit code → activity label (documentation; the codes are the contract).
const APPROVED_SIC = Object.freeze({
  '64191': 'Banks',
  '64192': 'Building societies',
  '64921': 'Credit granting — non-deposit-taking finance houses / consumer credit',
  '64922': 'Mortgage finance companies',
  '64929': 'Other credit granting n.e.c.',
  '64991': 'Security dealing on own account',
  '64999': 'Financial intermediation n.e.c.',
  '65110': 'Life insurance',
  '65120': 'Non-life insurance',
  '65201': 'Life reinsurance',
  '65202': 'Non-life reinsurance',
  '66110': 'Administration of financial markets',
  '66120': 'Security broking and fund management',
  '66190': 'Activities auxiliary to financial intermediation n.e.c.',
  '66220': 'Activities of insurance agents and brokers',
  '66290': 'Other activities auxiliary to insurance and pension funding',
  '66300': 'Fund management activities',
});

const APPROVED = new Set(Object.keys(APPROVED_SIC));

/**
 * Normalise a raw SIC token to its 5-digit code. Accepts the bulk-product form
 * ("66190 - Activities…"), the API form ("66190"), or a 4-digit legacy code; returns
 * null if no code is present. Deterministic, pure.
 */
function normaliseSic(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\d{4,5}/);   // the leading digit run is the SIC code
  return m ? m[0].padStart(5, '0') : null;
}

/** True iff a single SIC token (raw or normalised) is in the approved set. */
function isApprovedSic(raw) {
  const code = normaliseSic(raw);
  return code != null && APPROVED.has(code);
}

/** The approved SIC codes a company carries (deduped, in input order). */
function matchedApproved(sicCodes) {
  const matched = [];
  const seen = new Set();
  for (const c of (sicCodes || [])) {
    const code = normaliseSic(c);
    if (code && APPROVED.has(code) && !seen.has(code)) { seen.add(code); matched.push(code); }
  }
  return matched;
}

/** Candidate iff the company carries at least one approved financial SIC code. */
function isCandidate(sicCodes) { return matchedApproved(sicCodes).length > 0; }

module.exports = {
  SIC_SET_VERSION, APPROVED_SIC, APPROVED,
  normaliseSic, isApprovedSic, matchedApproved, isCandidate,
};
