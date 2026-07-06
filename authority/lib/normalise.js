'use strict';

// Shared normalisation for the canonical Organisation Dataset.
//
// These rules are the single source of truth for how identity strings are
// compared across every legacy registry. They deliberately match the existing
// Observatory provider (acquisition/providers/fca-organisation-provider.js
// `normaliseDomain`) so that domains produced here join the domain-keyed
// `signal_*` observation store byte-for-byte.

// Domain: lowercase, strip scheme, strip leading www., strip any path/query.
function normaliseDomain(raw) {
  if (!raw) return null;
  const d = String(raw)
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[/?#].*$/, '')
    .trim();
  return d.length > 0 ? d : null;
}

// Companies House number: uppercase, strip spaces. CH numbers are 8 chars,
// either 8 digits (zero-padded) or a 2-letter prefix + 6 digits (OC…, SC…,
// FC…, NI…, BR…). A purely-numeric number shorter than 8 is zero-padded so
// FCA "3565404" and CH "03565404" collapse to one identity.
function normaliseCompanyNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).toUpperCase().replace(/\s+/g, '').trim();
  if (s.length === 0) return null;
  if (/^\d+$/.test(s) && s.length < 8) s = s.padStart(8, '0');
  return s;
}

// FRN / SRA number / UKPRN: digits only, no leading zeros (they are integer
// identifiers, not fixed-width codes).
function normaliseNumericId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  return s.length > 0 ? s : null;
}

// Corporate name normalisation for reporting and *soft* duplicate detection
// only — never used as a merge key. Uppercase, strip punctuation, collapse
// whitespace, drop common legal suffixes.
const LEGAL_SUFFIXES = [
  'LIMITED', 'LTD', 'PUBLIC LIMITED COMPANY', 'PLC', 'LLP', 'LP',
  'LIMITED LIABILITY PARTNERSHIP', 'COMPANY', 'CO', 'INCORPORATED', 'INC',
  'INTERNATIONAL', 'HOLDINGS', 'GROUP', 'UK', 'THE',
];

function normaliseName(raw) {
  if (!raw) return null;
  let s = String(raw)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  // Iteratively strip trailing legal suffixes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of LEGAL_SUFFIXES) {
      if (s === suf) continue;
      const re = new RegExp('\\s' + suf + '$');
      if (re.test(s)) { s = s.replace(re, '').trim(); changed = true; }
    }
  }
  return s.length > 0 ? s : null;
}

module.exports = {
  normaliseDomain,
  normaliseCompanyNumber,
  normaliseNumericId,
  normaliseName,
};
