'use strict';

// tld-classifier.js — TLD type classification
//
// Classifies a domain's TLD into one of five types per SOT-DOMAINREGISTRATION-001 §7.4:
//   GTLD      — legacy generic TLDs (com, net, org, int, edu, gov, mil)
//   CCTLD     — country code TLDs (all 2-letter TLDs; tld_country_code populated)
//   NEW_GTLD  — post-2012 ICANN-delegated generic TLDs
//   SPONSORED — sponsored TLDs (aero, museum, coop, etc.)
//   UNKNOWN   — TLD not found in classification snapshot
//
// tld_country_code is populated only for CCTLD type (ISO 3166-1 alpha-2 uppercase).
// For all other types, tld_country_code is null.
//
// Authority: COL-DOMAINREGISTRATION-001 Part 6 — Classification Layer

// Suffix extraction reuses the approved, pinned Public Suffix List dependency
// (`psl`) — the same capability used by SOT-DNSPROVISION-001 §4.3. No new
// dataset is introduced (P1-1a). The PSL version is recorded for provenance.
const psl = require('psl');
const PSL_VERSION = (() => {
  try {
    const fs = require('node:fs');
    return 'psl@' + JSON.parse(fs.readFileSync(require.resolve('psl/package.json'), 'utf8')).version;
  } catch {
    return 'psl@unknown';
  }
})();

// ── Classification data ───────────────────────────────────────────────────────

// Legacy gTLDs predating 2012 ICANN new gTLD programme
const LEGACY_GTLD = new Set([
  'com', 'net', 'org', 'int', 'edu', 'gov', 'mil', 'arpa',
  // Historic two-letter pseudo-ccTLDs treated as gTLD by IANA
  'eu',
]);

// Sponsored TLDs (RFC 1591 category 4 and ICANN sponsored delegations)
const SPONSORED_TLDS = new Set([
  'aero', 'asia', 'cat', 'coop', 'jobs', 'mobi', 'museum',
  'post', 'tel', 'travel', 'xxx',
]);

// ISO 3166-1 alpha-2 → country name mapping for known ccTLD mappings.
// Used to populate tld_country_code for 2-letter TLDs.
// TLDs not in this map that are 2 letters get code = TLD.toUpperCase() as fallback.
// Note: some 2-letter TLDs (eu) are gTLDs — handled by LEGACY_GTLD check first.
const TWO_LETTER_COUNTRY_CODES = new Set([
  'ac', 'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'ao', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax',
  'az', 'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bm', 'bn', 'bo', 'bq', 'br', 'bs',
  'bt', 'bv', 'bw', 'by', 'bz', 'ca', 'cc', 'cd', 'cf', 'cg', 'ch', 'ci', 'ck', 'cl', 'cm', 'cn',
  'co', 'cr', 'cu', 'cv', 'cw', 'cx', 'cy', 'cz', 'de', 'dj', 'dk', 'dm', 'do', 'dz', 'ec', 'ee',
  'eg', 'eh', 'er', 'es', 'et', 'fi', 'fj', 'fk', 'fm', 'fo', 'fr', 'ga', 'gb', 'gd', 'ge', 'gf',
  'gg', 'gh', 'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt', 'gu', 'gw', 'gy', 'hk', 'hm',
  'hn', 'hr', 'ht', 'hu', 'id', 'ie', 'il', 'im', 'in', 'io', 'iq', 'ir', 'is', 'it', 'je', 'jm',
  'jo', 'jp', 'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'ky', 'kz', 'la', 'lb', 'lc',
  'li', 'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly', 'ma', 'mc', 'md', 'me', 'mf', 'mg', 'mh', 'mk',
  'ml', 'mm', 'mn', 'mo', 'mp', 'mq', 'mr', 'ms', 'mt', 'mu', 'mv', 'mw', 'mx', 'my', 'mz', 'na',
  'nc', 'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr', 'nu', 'nz', 'om', 'pa', 'pe', 'pf', 'pg',
  'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps', 'pt', 'pw', 'py', 'qa', 're', 'ro', 'rs', 'ru', 'rw',
  'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'sh', 'si', 'sj', 'sk', 'sl', 'sm', 'sn', 'so', 'sr', 'ss',
  'st', 'su', 'sv', 'sx', 'sy', 'sz', 'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl', 'tm', 'tn',
  'to', 'tr', 'tt', 'tv', 'tw', 'tz', 'ua', 'ug', 'uk', 'um', 'us', 'uy', 'uz', 'va', 'vc', 've',
  'vg', 'vi', 'vn', 'vu', 'wf', 'ws', 'ye', 'yt', 'za', 'zm', 'zw',
]);

// ── Snapshot loader ───────────────────────────────────────────────────────────

/**
 * Creates a TLD classification snapshot object.
 * In v1, classification is derived from static sets above.
 * snapshotDate records the effective date of this classification data.
 *
 * Future versions may load from an IANA-sourced data file.
 *
 * @returns {TldSnapshot}
 */
function loadTldSnapshot() {
  return {
    snapshotDate: '2026-06-20',
    pslVersion:   PSL_VERSION,
    classify:     classifyTld,
  };
}

// ── Classification function ───────────────────────────────────────────────────

/**
 * Classifies the TLD of a domain into one of five type values.
 *
 * For multi-part TLDs (co.uk), the effective TLD is derived from the domain
 * by matching against the bootstrap TLD map — pass the tld string extracted
 * from rdap-bootstrap resolveRdapEndpoint(), not the raw domain.
 *
 * @param {string} domain - Full domain name
 * @param {string|null} [resolvedTld] - TLD already resolved from bootstrap (preferred)
 * @returns {TldClassification}
 */
function classifyTld(domain, resolvedTld = null) {
  // Suffix extraction uses the PSL (the approved `psl` dependency). A caller may
  // still supply a pre-resolved suffix (back-compat); otherwise PSL governs.
  // A suffix not present in the PSL ("not listed") cannot be matched against the
  // reference and is therefore UNKNOWN (§7.4). (P1-1a / finding M4.)
  let tld, listed;
  if (resolvedTld) {
    tld = resolvedTld;
    listed = true;
  } else {
    const ext = _extractTldViaPsl(domain);
    tld = ext.tld;
    listed = ext.listed;
  }

  if (!tld || !listed) {
    return { tldString: tld ?? null, tldType: 'UNKNOWN', tldCountryCode: null };
  }

  const tldLower = tld.toLowerCase();

  // Legacy gTLD check first (catches 'eu' before 2-letter check)
  if (LEGACY_GTLD.has(tldLower)) {
    return { tldString: tld, tldType: 'GTLD', tldCountryCode: null };
  }

  // Sponsored TLD
  if (SPONSORED_TLDS.has(tldLower)) {
    return { tldString: tld, tldType: 'SPONSORED', tldCountryCode: null };
  }

  // 2-letter → ccTLD (single-label only; multi-part like co.uk already resolved by bootstrap)
  if (tldLower.length === 2 && !tldLower.includes('.') && TWO_LETTER_COUNTRY_CODES.has(tldLower)) {
    return {
      tldString:       tld,
      tldType:         'CCTLD',
      tldCountryCode:  tldLower.toUpperCase(),
    };
  }

  // Multi-part TLDs like co.uk / com.au — classify as CCTLD, derive country from last label
  if (tldLower.includes('.')) {
    const lastLabel = tldLower.split('.').pop();
    const countryCode = (lastLabel.length === 2 && TWO_LETTER_COUNTRY_CODES.has(lastLabel))
      ? lastLabel.toUpperCase()
      : null;
    return { tldString: tld, tldType: 'CCTLD', tldCountryCode: countryCode };
  }

  // A listed public suffix matching none of the curated type sets is a delegated
  // generic TLD (post-2012 programme).
  if (tldLower.length > 2) {
    return { tldString: tld, tldType: 'NEW_GTLD', tldCountryCode: null };
  }

  return { tldString: tld, tldType: 'UNKNOWN', tldCountryCode: null };
}

// ── PSL-based TLD extraction ──────────────────────────────────────────────────

/**
 * Extracts the public suffix (TLD) of a domain via the PSL. Returns the suffix
 * string (e.g. 'com', 'co.uk', 'london') and whether it is present in the list.
 * A non-listed suffix is treated as UNKNOWN by the caller (§7.4).
 *
 * @param {string} domain
 * @returns {{ tld: string|null, listed: boolean }}
 */
function _extractTldViaPsl(domain) {
  if (!domain || typeof domain !== 'string') return { tld: null, listed: false };
  const h = domain.toLowerCase().replace(/\.$/, '').trim();
  if (!h) return { tld: null, listed: false };

  let parsed;
  try { parsed = psl.parse(h); } catch { return { tld: null, listed: false }; }
  if (!parsed || parsed.error || !parsed.tld) return { tld: null, listed: false };

  return { tld: parsed.tld, listed: parsed.listed === true };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { classifyTld, loadTldSnapshot };

/**
 * @typedef {Object} TldSnapshot
 * @property {string} snapshotDate - ISO date string
 * @property {function} classify - classifyTld function
 */

/**
 * @typedef {Object} TldClassification
 * @property {string|null} tldString
 * @property {'GTLD'|'CCTLD'|'NEW_GTLD'|'SPONSORED'|'UNKNOWN'} tldType
 * @property {string|null} tldCountryCode
 */
