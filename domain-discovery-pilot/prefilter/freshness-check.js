'use strict';

// freshness-check.js — one bounded homepage fetch for a SINGLE_PROBABLE_MATCH
// + VERIFIED candidate, to decide whether Brave search can be skipped.
// No extra retries beyond fetchUrl's own default; no LLM.

const { normaliseName } = require('../../authority/lib/normalise');
const { normalisePostcode } = require('./postcode-normalise');

/**
 * checkFreshness(candidate, matchedDomain, deps) -> {
 *   resolves, evidence, verdict, fetchResult
 * }
 *
 * deps: { fetchUrl, maxRetries } — injectable for offline tests.
 * verdict: CURRENT | STALE | CONTRADICTORY | INCONCLUSIVE
 */
async function checkFreshness(candidate, matchedDomain, deps = {}) {
  const fetchUrl = deps.fetchUrl || require('../../commercial-observatory/sources/web-fetch').fetchUrl;
  const url = `https://${matchedDomain}`;

  const fetchResult = await fetchUrl(url, { maxRetries: 0, ...(deps.fetchOptions || {}) });

  if (!fetchResult.success) {
    return { resolves: false, evidence: 'INSUFFICIENT', verdict: 'STALE', fetchResult };
  }

  const bodyUpper = String(fetchResult.body || '').toUpperCase();
  const candidateNameNorm = normaliseName(candidate.businessName);
  const nameOnPage = candidateNameNorm
    ? candidateNameNorm.split(' ').filter((t) => t.length > 2).every((t) => bodyUpper.includes(t))
    : false;

  const candidatePostcodeNorm = normalisePostcode(candidate.postcode);
  let postcodeOnPage = null;
  if (candidatePostcodeNorm) {
    const compact = candidatePostcodeNorm.replace(/\s+/g, '');
    postcodeOnPage = bodyUpper.replace(/\s+/g, '').includes(compact);
  }

  const pageIsEmpty = bodyUpper.trim().length === 0;

  let evidence;
  if (nameOnPage && (postcodeOnPage === true || postcodeOnPage === null)) {
    evidence = 'EVIDENCE_CONSISTENT';
  } else if (pageIsEmpty) {
    evidence = 'EVIDENCE_INSUFFICIENT';
  } else if (nameOnPage === false || postcodeOnPage === false) {
    evidence = 'EVIDENCE_CONTRADICTED';
  } else {
    evidence = 'EVIDENCE_INSUFFICIENT';
  }

  let verdict;
  if (evidence === 'EVIDENCE_CONSISTENT') verdict = 'CURRENT';
  else if (evidence === 'EVIDENCE_CONTRADICTED') verdict = 'CONTRADICTORY';
  else verdict = 'INCONCLUSIVE';

  return { resolves: true, evidence, verdict, fetchResult };
}

module.exports = { checkFreshness };
