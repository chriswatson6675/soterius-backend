'use strict';

// fetch-candidate-pages.js — bounded fetch of up to 3 pages per candidate
// domain: the homepage, then up to 2 more internal pages matching
// /contact|about|legal|terms|privacy/i (priority: contact, about, legal),
// reusing fetchUrl + extractHtml exactly as they exist today.

const { fetchUrl } = require('../../commercial-observatory/sources/web-fetch');
const { extractHtml } = require('../../commercial-observatory/sources/html-extract');

const LINK_ROLE_PRIORITY = ['contact', 'about', 'legal'];
const LINK_ROLE_RE = {
  contact: /contact/i,
  about: /about/i,
  legal: /legal|terms|privacy/i,
};

function classifyLinkRole(link) {
  const haystack = `${link.href} ${link.text}`;
  for (const role of LINK_ROLE_PRIORITY) {
    if (LINK_ROLE_RE[role].test(haystack)) return role;
  }
  return null;
}

/**
 * fetchCandidatePages(domain, deps) -> [{ requestedUrl, finalUrl, status,
 *   contentType, pageRole, fetchResult, extracted }]
 *
 * deps: { fetchUrl, maxPages } — injectable for offline tests.
 */
async function fetchCandidatePages(domain, deps = {}) {
  const doFetch = deps.fetchUrl || fetchUrl;
  const maxPages = deps.maxPages ?? 3;
  const homepageUrl = `https://${domain}`;

  const pages = [];
  const homepageResult = await doFetch(homepageUrl, deps.fetchOptions);
  const homepageExtracted = homepageResult.success ? extractHtml(homepageResult.body, homepageResult.finalUrl || homepageUrl) : null;
  pages.push({ requestedUrl: homepageUrl, pageRole: 'homepage', fetchResult: homepageResult, extracted: homepageExtracted });

  if (!homepageResult.success || !homepageExtracted) return pages;

  const candidateLinks = homepageExtracted.internalLinks
    .map((link) => ({ ...link, role: classifyLinkRole(link) }))
    .filter((link) => link.role);

  const pickedByRole = new Map(); // role -> link (first seen, priority order preserved by scan below)
  for (const role of LINK_ROLE_PRIORITY) {
    const found = candidateLinks.find((l) => l.role === role);
    if (found) pickedByRole.set(role, found);
  }

  const toFetch = LINK_ROLE_PRIORITY
    .map((role) => pickedByRole.get(role))
    .filter(Boolean)
    .slice(0, Math.max(0, maxPages - 1));

  for (const link of toFetch) {
    const result = await doFetch(link.href, deps.fetchOptions);
    const extracted = result.success ? extractHtml(result.body, result.finalUrl || link.href) : null;
    pages.push({ requestedUrl: link.href, pageRole: link.role, fetchResult: result, extracted });
  }

  return pages;
}

module.exports = { fetchCandidatePages, classifyLinkRole, LINK_ROLE_PRIORITY };
