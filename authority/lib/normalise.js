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

// LEI (Legal Entity Identifier, ISO 17442): a fixed 20-character alphanumeric
// code whose final two characters are an ISO 7064 MOD 97-10 check-digit pair
// over the whole 20-character string (letters expanded to two-digit numbers,
// A=10 ... Z=35, per the same algorithm IBAN uses). Rejects anything that
// isn't exactly 20 alphanumeric characters or fails the checksum — in
// particular, non-LEI text that would otherwise survive a naive uppercase/
// strip pass (e.g. an embedded CSV header artifact read as if it were a data
// value; see ENG-031, which found exactly this happening for the literal
// text "Head Office LEI"). Deliberately does NOT enforce the "characters 5-6
// are reserved and always '00'" convention some LEI documentation states —
// verified against real GLEIF-issued LEIs (ENG-031's own worked examples,
// "BFXS5XCH7N0Y05NIXW11" and "724500973ODKK3IFQ447") that this does not hold
// in practice; enforcing it would reject valid real-world LEIs.
function normaliseLei(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, '').trim();
  if (!/^[0-9A-Z]{20}$/.test(s)) return null;
  const expanded = s.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  if (BigInt(expanded) % 97n !== 1n) return null;
  return s;
}

// GCN-004 register identifiers (frcAudit, hmrcAml, pbsFirm): a generic,
// light-touch normaliser — uppercase, strip whitespace, matching
// normaliseCompanyNumber's non-checksum-validating style. GCN-004 §E.1
// explicitly defers each register's exact normalisation convention to the
// engineering task that wires in its first real source (ENG-030 §4 open
// decision #1) — this is a deliberate placeholder, not a considered
// per-register rule. It exists so the merge/precedence machinery has
// something to call for these three fields today; refine per-register once
// FRC/PBS sources are onboarded and HMRC AML's real registration-number
// format is validated against production data (mirroring how the HMRC AML
// adapter's own field handling was validated against the real register
// export in WP-2, not invented up front).
function normaliseRegisterId(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).toUpperCase().replace(/\s+/g, '').trim();
  return s.length > 0 ? s : null;
}

module.exports = {
  normaliseDomain,
  normaliseCompanyNumber,
  normaliseNumericId,
  normaliseName,
  normaliseLei,
  normaliseRegisterId,
};
