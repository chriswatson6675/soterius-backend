'use strict';

// query-templates.js — fixed, bounded, versioned Brave query templates for
// the Domain Discovery Pilot (Step 2 of the approved pilot spec). Exactly 2
// templates, no LLM, no runtime template generation.

const QUERY_TEMPLATE_VERSION = 'DDP-QT-v1.0';

/**
 * buildQueries({ businessName, postcode }) -> [{ templateId, query }]
 *
 * Template 1: `"{businessName}" {postcode}` — omitted gracefully (falls back
 * to just `"{businessName}"`, per spec) when postcode is missing.
 * Template 2: `"{businessName}" official website`
 */
function buildQueries({ businessName, postcode } = {}) {
  const name = String(businessName || '').trim();
  const pc = String(postcode || '').trim();

  const queries = [];
  queries.push({
    templateId: 'DDP-QT-1',
    query: pc ? `"${name}" ${pc}` : `"${name}"`,
  });
  queries.push({
    templateId: 'DDP-QT-2',
    query: `"${name}" official website`,
  });
  return queries;
}

// Fixed, bounded, versioned domain-exclusion list — aggregators,
// directories, business-data resellers, and regulators that can never
// themselves be the business's own domain. Every entry is a host PATTERN:
// isExcludedDomain matches it exactly OR as a parent of any subdomain, so
// adding one entry (e.g. 'cylex-uk.co.uk') covers every one of its local
// subdomains (e.g. 'shrewsbury.cylex-uk.co.uk') without listing each city.
//
// v1.1 (bumped from v1.0 by the five-record live smoke test, which
// surfaced dnb.com/ico.org.uk/privco.com/cylex-uk.co.uk passing the v1.0
// list unfiltered — none of them are a business's own domain, but the
// pipeline's downstream scoring correctly rejected all of them anyway, so
// this is a fetch-budget/noise fix, not a correctness fix).
const EXCLUSION_LIST_VERSION = 'DDP-EXCL-v1.1';

const EXCLUDED_DOMAINS = Object.freeze([
  'companieshouse.gov.uk',
  'gov.uk',
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'yell.com',
  'trustpilot.com',
  'wikipedia.org',
  'indeed.com',
  'glassdoor.co.uk',
  'checkatrade.com',
  'yelp.com',
  'crunchbase.com',
  'bloomberg.com',
  'opencorporates.com',
  'dnb.com',
  'ico.org.uk',
  'privco.com',
  'cylex-uk.co.uk',
]);

/**
 * isExcludedDomain(domain) — true if `domain` equals or is a subdomain of
 * any entry in EXCLUDED_DOMAINS (exact host-pattern matching — a lookalike
 * like 'notdnb.com' or 'dnb.com.evil.com' never matches, since neither
 * equals 'dnb.com' nor ends with '.dnb.com'). `domain` is expected already
 * normalised (lowercase, no scheme/www/path) via
 * authority/lib/normalise#normaliseDomain, and this function is
 * additionally case-insensitive itself as defense-in-depth.
 */
function isExcludedDomain(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  return EXCLUDED_DOMAINS.some((excluded) => d === excluded || d.endsWith(`.${excluded}`));
}

module.exports = { QUERY_TEMPLATE_VERSION, EXCLUSION_LIST_VERSION, buildQueries, EXCLUDED_DOMAINS, isExcludedDomain };
