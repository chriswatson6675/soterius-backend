'use strict';

// Deterministic research-page selection (execution architecture design,
// §E "Decide Next Action" applied to homepage links). No LLM, no crawling —
// a fixed set of keyword rules, MVP-0's link-depth-1 / homepage+8 limits
// (from url-policy.js), same-registrable-domain only.

const urlPolicy = require('./../sources/url-policy');

// Ordered so the FIRST matching category is the one recorded — used both
// for the score and for research-website.js's completeness indicator.
const CATEGORY_KEYWORDS = Object.freeze([
  { category: 'about', keywords: ['about', 'who we are', 'who-we-are', 'our story'] },
  { category: 'services', keywords: ['services', 'expertise', 'what we do'] },
  { category: 'sectors', keywords: ['sectors', 'industries'] },
  { category: 'people', keywords: ['team', 'people', 'leadership', 'our people'] },
  { category: 'partners', keywords: ['partners', 'partnership', 'partnerships'] },
  { category: 'clients', keywords: ['clients', 'case studies', 'case-studies', 'case study'] },
  { category: 'credentials', keywords: ['memberships', 'membership', 'accreditation', 'accreditations', 'certification', 'certifications', 'regulator', 'regulators', 'compliance'] },
  { category: 'content', keywords: ['resources', 'insights', 'articles', 'news', 'blog'] },
]);

const DENY_RULES = Object.freeze([
  { reason: 'privacy_or_legal', keywords: ['privacy', 'cookie', 'terms', 'gdpr', 'disclaimer'] },
  { reason: 'account_or_transactional', keywords: ['login', 'signin', 'sign-in', 'my-account', 'account', 'basket', 'cart', 'checkout'] },
  { reason: 'careers_deprioritised', keywords: ['careers', 'jobs', 'vacancies', 'recruitment'] },
  { reason: 'pagination_or_search', keywords: ['/page/', '/tag/', '/category/', 'search', '?s='] },
]);

function matchesAny(haystack, keywords) {
  return keywords.some((k) => haystack.includes(k));
}

function scoreAndCategorise(hrefLower, labelLower) {
  const combined = `${hrefLower} ${labelLower}`;
  let score = 0;
  let category = null;
  for (const { category: cat, keywords } of CATEGORY_KEYWORDS) {
    const matched = keywords.filter((k) => combined.includes(k)).length;
    if (matched > 0) {
      score += matched;
      if (!category) category = cat;
    }
  }
  return { score, category };
}

function denyReason(hrefLower, labelLower) {
  const combined = `${hrefLower} ${labelLower}`;
  for (const { reason, keywords } of DENY_RULES) {
    if (matchesAny(combined, keywords)) return reason;
  }
  return null;
}

function isGenericContactPage(hrefLower) {
  try {
    const pathname = new URL(hrefLower).pathname;
    const segments = pathname.split('/').filter(Boolean);
    return segments.some((s) => s === 'contact' || s === 'contact-us');
  } catch {
    return false;
  }
}

/**
 * selectResearchPages(homepageUrl, links, options)
 *   links: [{href, text}] — internal links from html-extract.js's homepage extraction.
 *   options: { rootDomain, maxAdditionalPages }
 *
 * Returns { selected: [{url, label, score, category}], rejected: [{url, label, reason}] }
 * — deterministic: same input always produces the same output and order.
 */
function selectResearchPages(homepageUrl, links, options = {}) {
  const rootDomain = options.rootDomain || homepageUrl;
  const maxAdditionalPages = options.maxAdditionalPages ?? urlPolicy.MAX_ADDITIONAL_PAGES;
  const normalisedHomepage = urlPolicy.normaliseUrl(homepageUrl);

  const selected = [];
  const rejected = [];
  const seen = new Set([normalisedHomepage]);

  const scored = [];

  for (const link of links || []) {
    const url = urlPolicy.normaliseUrl(link.href, homepageUrl);
    const label = link.text || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);

    if (!urlPolicy.isAllowedProtocol(url)) { rejected.push({ url, label, reason: 'unsupported_protocol' }); continue; }
    if (urlPolicy.exceedsMaxUrlLength(url)) { rejected.push({ url, label, reason: 'url_too_long' }); continue; }
    if (urlPolicy.hasRejectedExtension(url)) { rejected.push({ url, label, reason: 'unsupported_file_type' }); continue; }
    if (!urlPolicy.isSameRegistrableDomain(url, rootDomain)) { rejected.push({ url, label, reason: 'external_domain' }); continue; }

    // Score against the PATH (+ query), never the full URL — the hostname
    // can itself contain a keyword substring (e.g. "complianceoffice.co.uk"
    // contains "compliance"), which would otherwise false-match every link.
    let pathAndQueryLower;
    try {
      const parsed = new URL(url);
      pathAndQueryLower = (parsed.pathname + parsed.search).toLowerCase();
    } catch {
      pathAndQueryLower = url.toLowerCase();
    }
    const labelLower = label.toLowerCase();

    const deny = denyReason(pathAndQueryLower, labelLower);
    if (deny) { rejected.push({ url, label, reason: deny }); continue; }

    if (isGenericContactPage(url.toLowerCase()) && !matchesAny(pathAndQueryLower, ['team', 'people', 'leadership'])) {
      rejected.push({ url, label, reason: 'generic_contact_form' });
      continue;
    }

    const { score, category } = scoreAndCategorise(pathAndQueryLower, labelLower);
    if (score === 0) { rejected.push({ url, label, reason: 'no_relevant_keyword_match' }); continue; }

    scored.push({ url, label, score, category });
  }

  // Stable sort (Node's Array#sort is stable) — deterministic tie-break by
  // original link order for equal scores.
  scored.sort((a, b) => b.score - a.score);

  scored.forEach((candidate, index) => {
    if (index < maxAdditionalPages) selected.push(candidate);
    else rejected.push({ url: candidate.url, label: candidate.label, reason: 'exceeded_page_cap' });
  });

  return { selected, rejected };
}

module.exports = { selectResearchPages, CATEGORY_KEYWORDS, DENY_RULES };
