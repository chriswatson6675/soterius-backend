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

// Fixed, bounded domain-exclusion list — aggregators/directories/social
// platforms that can never themselves be the business's own domain.
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
]);

/**
 * isExcludedDomain(domain) — true if `domain` equals or is a subdomain of
 * any entry in EXCLUDED_DOMAINS. `domain` is expected already normalised
 * (lowercase, no scheme/www/path) via authority/lib/normalise#normaliseDomain.
 */
function isExcludedDomain(domain) {
  if (!domain) return false;
  const d = String(domain).toLowerCase();
  return EXCLUDED_DOMAINS.some((excluded) => d === excluded || d.endsWith(`.${excluded}`));
}

module.exports = { QUERY_TEMPLATE_VERSION, buildQueries, EXCLUDED_DOMAINS, isExcludedDomain };
