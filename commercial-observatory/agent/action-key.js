'use strict';

// Canonical action-key + redirect-merge dedup (Parts 1-3). Distinct from
// sources/url-policy.js's `normaliseUrl` (used for link-collection during
// homepage crawling, where trailing-slash/fragment stripping is all that's
// needed) — this canonicalisation exists specifically to decide whether two
// PLANNED ACTIONS are the same materially-equivalent action, which needs
// two things url-policy.js's normaliser deliberately does not do:
//   - collapse a leading "www." (https://www.gov.uk/ === https://gov.uk/)
//   - strip known tracking-only query parameters (utm_*, gclid, fbclid...)
//     while preserving every other query parameter, which may change the
//     page's actual content (?tab=officers vs ?tab=filing-history).
// It also deliberately forces the scheme to https for the canonical KEY
// only — never for the real outbound request — so an http vs https link to
// the exact same host/path is recognised as one action before any fetch or
// redirect has even happened.

const TRACKING_PARAM_NAMES = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'igshid', '_ga',
]);

/**
 * canonicaliseUrl(rawUrl) -> canonical string, or null if unparseable.
 * `https://WWW.GOV.UK/guidance/?utm_source=x&b=2&a=1` and
 * `http://gov.uk/guidance` both canonicalise to `https://gov.uk/guidance`
 * (path trailing-slash and root-path both collapse; remaining query
 * parameters are kept but sorted for a stable key).
 */
function canonicaliseUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('www.') && hostname.length > 4) hostname = hostname.slice(4);

  let pathname = parsed.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname === '/') pathname = '';

  const keptParams = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_NAMES.has(key.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = keptParams.length ? `?${keptParams.map(([k, v]) => `${k}=${v}`).join('&')}` : '';

  return `https://${hostname}${pathname}${query}`;
}

/**
 * canonicaliseActionKey({toolName, toolInput}) -> string
 *
 * Per Part 1:
 *   - fetch_web_page / read_pdf: canonical URL (fragment/www/trailing-slash/
 *     tracking-params normalised, scheme forced) — the redirect-merge step
 *     (finalUrlByCanonical, see below) is applied by the ORCHESTRATOR before
 *     calling this, not inside it, since that requires run-scoped state this
 *     pure function does not carry.
 *   - companies_house_lookup / fca_lookup / sra_lookup: tool name + the
 *     normalised organisation identifier/name — NEVER the same key as a
 *     fetch_web_page action against that register's own page, since the
 *     tool name is always part of the key.
 *   - search_web: tool name + normalised query text.
 *   - anything else: falls back to the existing `${toolName}:${primary}`
 *     shape, unchanged.
 */
function canonicaliseActionKey({ toolName, toolInput = {} } = {}) {
  if (toolName === 'fetch_web_page' || toolName === 'read_pdf') {
    const canonical = canonicaliseUrl(toolInput.url);
    return `${toolName}:${canonical || toolInput.url || ''}`;
  }
  if (toolName === 'companies_house_lookup' || toolName === 'fca_lookup' || toolName === 'sra_lookup') {
    const identifier = (toolInput.companyNumber || toolInput.name || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    return `${toolName}:${identifier}`;
  }
  if (toolName === 'search_web') {
    const query = (toolInput.query || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
    return `${toolName}:${query}`;
  }
  const primary = toolInput.url || toolInput.query || toolInput.name || toolInput.companyNumber || '';
  return `${toolName}:${primary}`;
}

module.exports = { canonicaliseUrl, canonicaliseActionKey, TRACKING_PARAM_NAMES };
