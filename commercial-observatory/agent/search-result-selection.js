'use strict';

// Deterministic search-result selection (Part 3). Ranks raw search_web
// results (title/url/snippet — never themselves evidence) to decide which
// are worth fetching. A result only ever becomes evidence AFTER
// fetch_web_page retrieves and record_evidence preserves it — this module
// never marks anything as evidence itself.

const { registrableDomainOf, isSocialPlatform } = require('./co-party-identity');
const { canonicaliseUrl } = require('./action-key');

const KNOWN_REGISTER_DOMAINS = Object.freeze([
  'find-and-update.company-information.service.gov.uk',
  'register.fca.org.uk',
  'sra.org.uk',
]);

const KNOWN_AUTHORITY_SUFFIXES = Object.freeze(['gov.uk', 'org.uk', '.gov', 'nca.gov.uk']);

const LOW_QUALITY_DOMAIN_PATTERNS = Object.freeze([/^yell\./i, /^similarweb\./i, /^pinterest\./i, /^quora\./i]);

function hasLoginPath(url) {
  try {
    return /\/(login|signin|sign-in|account)(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Register domains are checked against the RAW hostname, not the
// registrable domain — "find-and-update.company-information.service.gov.uk"
// has a registrable domain of just "service.gov.uk" once .gov.uk (a public
// suffix) is stripped, which would never match a full-hostname list.
function isKnownRegisterHost(hostname) {
  return !!hostname && KNOWN_REGISTER_DOMAINS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

function looksLikeAuthorityDomain(domain) {
  return !!domain && KNOWN_AUTHORITY_SUFFIXES.some((s) => domain === s || domain.endsWith(`.${s}`) || domain.endsWith(s));
}

function isLowQualityDomain(domain) {
  return !!domain && LOW_QUALITY_DOMAIN_PATTERNS.some((p) => p.test(domain));
}

/**
 * Relevance signal for one text field against the target name — a bare
 * single common word (e.g. "office" from "Compliance Office") is not
 * enough to call a result relevant; either the full name must appear, or,
 * for a multi-word name, EVERY distinctive word must appear.
 */
function relevanceScore(haystack, name) {
  if (!haystack || !name) return 0;
  const lower = haystack.toLowerCase();
  const lowerName = name.toLowerCase();
  if (lower.includes(lowerName)) return 2;
  const words = lowerName.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 1 && words.every((w) => lower.includes(w))) return 1;
  return 0;
}

/**
 * selectSearchResults(results, options) -> { selected: [...], rejected: [...] }
 *
 * options: { targetName, targetDomain, alreadyFetchedCanonicalUrls:
 *   Set<string>, maxSelected }
 *
 * `alreadyFetchedCanonicalUrls` holds CANONICAL URLs (action-key.js's
 * canonicaliseUrl — www/trailing-slash/tracking-param normalised), not
 * bare domains — Part 4's "domain versus page precision": a third-party
 * domain already visited this run is only rejected when the SPECIFIC page
 * was already fetched, never merely for sharing a domain with something
 * already seen (the Companies House "company overview" vs "officers" pages
 * must both remain reachable).
 *
 * Each selected result carries { ...result, score, category, reason }.
 * Each rejected result carries { ...result, reason }.
 */
function selectSearchResults(results, options = {}) {
  const { targetName, targetDomain, alreadyFetchedCanonicalUrls = new Set(), maxSelected = 2 } = options;

  const selected = [];
  const rejected = [];
  const seenDomains = new Set();

  for (const result of results || []) {
    const domain = registrableDomainOf(result.url);
    const hostname = hostnameOf(result.url);

    if (!domain) { rejected.push({ ...result, reason: 'unparseable_url' }); continue; }
    if (isSocialPlatform(domain)) { rejected.push({ ...result, reason: 'social_platform' }); continue; }
    if (isLowQualityDomain(domain)) { rejected.push({ ...result, reason: 'low_quality_aggregator' }); continue; }
    if (hasLoginPath(result.url)) { rejected.push({ ...result, reason: 'login_page' }); continue; }
    if (seenDomains.has(domain)) { rejected.push({ ...result, reason: 'duplicate_domain_in_result_set' }); continue; }
    // Only the SPECIFIC canonical URL already fetched is rejected — not
    // every result sharing its domain. This is what lets a second,
    // genuinely different page on an already-visited domain (or on the
    // target's own domain) still be selected.
    const canonicalUrl = canonicaliseUrl(result.url);
    if (canonicalUrl && alreadyFetchedCanonicalUrls.has(canonicalUrl)) { rejected.push({ ...result, reason: 'url_already_fetched' }); continue; }

    const titleRelevance = relevanceScore(result.title, targetName);
    const snippetRelevance = relevanceScore(result.snippet, targetName);
    if (!result.snippet && titleRelevance === 0) { rejected.push({ ...result, reason: 'empty_snippet_no_relevance' }); continue; }

    let score = 0;
    let category = 'other';

    if (domain === targetDomain) { score += 3; category = 'first_party'; }
    if (isKnownRegisterHost(hostname)) { score += 3; category = 'register'; }
    else if (looksLikeAuthorityDomain(domain)) { score += 2; category = category === 'other' ? 'regulator_or_authority' : category; }
    score += Math.max(titleRelevance, snippetRelevance);
    if (result.url && result.url.toLowerCase().endsWith('.pdf')) { score += 1; category = category === 'other' ? 'pdf' : category; }

    if (score <= 0) {
      // No relevance signal at all beyond mere co-occurrence in a result
      // set — likely an unrelated similarly-named firm or a generic page.
      rejected.push({ ...result, reason: 'low_relevance' });
      continue;
    }

    seenDomains.add(domain);
    selected.push({ ...result, score, category, reason: 'selected' });
  }

  selected.sort((a, b) => b.score - a.score);
  const overflow = selected.splice(maxSelected);
  for (const o of overflow) rejected.push({ ...o, reason: 'exceeded_max_selected' });

  return { selected, rejected };
}

module.exports = { selectSearchResults, looksLikeAuthorityDomain, isLowQualityDomain };
