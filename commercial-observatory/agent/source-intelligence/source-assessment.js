'use strict';

// Source Intelligence — a deterministic Source Assessment computed for a
// candidate URL BEFORE it is ever fetched. This is a second, more
// comprehensive gate on top of search-result-selection.js's simpler
// relevance/category scoring: where selectSearchResults decides which
// *search results* are worth fetching, assessSource judges ANY candidate
// URL (a search result, a hyperlink discovered on a fetched page, a
// co-party candidate) against the fuller set of dimensions the Research
// Agent actually needs to avoid wasting its bounded budget on generically-
// relevant but organisationally-irrelevant pages (e.g. a US government
// occupational handbook page about "compliance officers" the job title,
// which shares vocabulary with "Compliance Office" the company but has
// zero bearing on it).
//
// Two operating modes:
//   - TARGET mode (targetName/targetDomain supplied, typically with a
//     title/snippet from a search result): scores relevance *to the
//     investigation's own target*.
//   - STANDALONE mode (no target supplied, typically a co-party candidate
//     discovered via hyperlink extraction): scores the candidate source's
//     own intrinsic quality — is it a real, identifiable, evidence-worthy
//     organisation, or noise (a job board, a login page, a directory)?
//
// A result/link is still never itself evidence — assessSource only decides
// whether fetch_web_page is worth spending budget on; only the fetched
// page's own preserved content can ever become evidence.

const { registrableDomainOf, isSocialPlatform } = require('../co-party-identity');
const { looksLikeAuthorityDomain, isLowQualityDomain } = require('../search-result-selection');

// ── Known domain classification lists ──────────────────────────────────────
// Deliberately small, explicit, and additive to the lists already in
// search-result-selection.js — this module does not re-implement register
// detection, it classifies more broadly around it.

const REGULATOR_DOMAINS = Object.freeze([
  'find-and-update.company-information.service.gov.uk', 'register.fca.org.uk', 'sra.org.uk',
  'gov.uk', 'ico.org.uk', 'legislation.gov.uk', 'fca.org.uk', 'companieshouse.gov.uk',
  'hmrc.gov.uk',
]);

const PROFESSIONAL_BODY_DOMAINS = Object.freeze([
  'lawsociety.org.uk', 'sra.org.uk', 'cilex.org.uk', 'icaew.com', 'accaglobal.com',
  'lawgazette.co.uk', 'barcouncil.org.uk',
]);

const NEWS_PUBLICATION_DOMAINS = Object.freeze([
  'bbc.co.uk', 'ft.com', 'theguardian.com', 'legalfutures.co.uk', 'lawgazette.co.uk',
  'thetimes.co.uk', 'telegraph.co.uk', 'independent.co.uk', 'reuters.com',
]);

const COMMERCIAL_DIRECTORY_DOMAINS = Object.freeze([
  'yell.com', 'trustpilot.com', 'glassdoor.co.uk', 'glassdoor.com', 'g2.com', 'capterra.com',
  'dnb.com', 'zoominfo.com', 'rocketreach.co', 'visualvisitor.com', 'similarweb.com',
  'crunchbase.com', 'bloomberg.com',
]);

// Generic reference / encyclopaedic sites: informative but not about any
// specific organisation — a dictionary/glossary entry on "compliance
// officer" the job title is never evidence about a specific firm.
const GENERIC_REFERENCE_DOMAINS = Object.freeze([
  'investopedia.com', 'wikipedia.org', 'onetonline.org', 'careeronestop.org',
  'bls.gov', 'dol.gov',
]);

// UK top-level/second-level domain suffixes.
const UK_DOMAIN_SUFFIX = '.uk';
const KNOWN_NON_UK_SUFFIXES = Object.freeze(['.gov', '.us', '.de', '.fr', '.ca', '.au', '.nl', '.es', '.it', '.cn', '.ru', '.in', '.jp', '.edu']);

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function domainMatches(domain, list) {
  return !!domain && list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** UK / non_uk / unknown — a .com/.org/.net TLD alone is genuinely ambiguous (many UK firms use them). */
function classifyJurisdiction(domain) {
  if (!domain) return 'unknown';
  if (domain.endsWith(UK_DOMAIN_SUFFIX)) return 'uk';
  if (KNOWN_NON_UK_SUFFIXES.some((s) => domain.endsWith(s))) return 'non_uk';
  return 'unknown';
}

/**
 * Mutually exclusive source classification, evaluated in priority order —
 * a domain that happens to be both a register AND end in .gov.uk is
 * simply 'regulator', not double-counted.
 */
function classifySource(domain, targetDomain) {
  if (!domain) return 'unknown';
  if (targetDomain && domain === targetDomain) return 'first_party';
  if (isSocialPlatform(domain)) return 'social_platform';
  if (domainMatches(domain, REGULATOR_DOMAINS)) return 'regulator';
  if (domainMatches(domain, PROFESSIONAL_BODY_DOMAINS)) return 'professional_body';
  if (domainMatches(domain, NEWS_PUBLICATION_DOMAINS)) return 'news_publication';
  if (domainMatches(domain, COMMERCIAL_DIRECTORY_DOMAINS) || isLowQualityDomain(domain)) return 'commercial_directory';
  if (domainMatches(domain, GENERIC_REFERENCE_DOMAINS)) return 'generic_reference';
  return 'unrelated_organisation';
}

const CLASSIFICATION_AUTHORITY_BASE = Object.freeze({
  regulator: 95, professional_body: 85, first_party: 60, news_publication: 65,
  commercial_directory: 30, generic_reference: 35, vendor: 40, social_platform: 5,
  // 'unrelated_organisation' means "not yet classified into a known
  // category" — NOT "confirmed irrelevant". In standalone (co-party) mode
  // this is very often a genuine, previously-unseen third party (a real
  // vendor, partner or client) that co-party discovery exists to surface;
  // giving it a punitive base score would defeat that purpose. Genuinely
  // low-value classes (generic_reference, commercial_directory,
  // social_platform) are penalised explicitly below instead.
  unrelated_organisation: 45, unknown: 15,
});

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Full-name whole-word match, or every distinctive word present as a whole
 * word — matches search-result-selection.js's discipline (never a single
 * common word) but uses word-boundary matching rather than plain substring
 * matching, so "Compliance Officers" (the job title) does not falsely
 * satisfy a match against "Compliance Office" (the company) merely because
 * "office" is a substring of "officers".
 */
function relevanceSignal(haystack, name) {
  if (!haystack || !name) return 0;
  const lower = haystack.toLowerCase();
  const lowerName = name.toLowerCase();
  if (new RegExp(`\\b${escapeRegex(lowerName)}\\b`).test(lower)) return 2;
  const words = lowerName.split(/\s+/).filter((w) => w.length > 2);
  if (words.length > 1 && words.every((w) => new RegExp(`\\b${escapeRegex(w)}\\b`).test(lower))) return 1;
  return 0;
}

const REGULATORY_KEYWORDS = /\b(SRA|FCA|COLP|COFA|AML|ICO|compliance|regulatory|regulator|anti-money laundering)\b/i;

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * weightedComposite([{value, weight}, ...]) — renormalises weights over
 * only the dimensions that were actually computed (value !== null), so a
 * standalone (no-target) assessment doesn't get unfairly diluted by
 * dimensions that genuinely don't apply.
 */
function weightedComposite(dims) {
  const available = dims.filter((d) => d.value !== null && d.value !== undefined);
  const totalWeight = available.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight === 0) return 0;
  const sum = available.reduce((acc, d) => acc + d.value * (d.weight / totalWeight), 0);
  return clamp(sum);
}

/**
 * assessSource(candidate) -> Source Assessment
 *
 * candidate: {
 *   url,                          // required
 *   name,                         // optional — a discovered/link display name
 *   title, snippet,               // optional — from a search result
 *   targetName, targetDomain,     // optional — omit for standalone (co-party) mode
 * }
 */
function assessSource(candidate = {}) {
  const url = candidate.url;
  const domain = registrableDomainOf(url);
  const hostname = hostnameOf(url);
  const targetName = candidate.targetName || null;
  const targetDomain = candidate.targetDomain || null;
  const hasTargetContext = !!(targetName || targetDomain);

  if (!domain) {
    return {
      url, domain: null, classification: 'unknown', partyType: 'third_party', jurisdiction: 'unknown',
      authority: 0, commercialRelevance: null, regulatoryRelevance: 0, organisationRelevance: null,
      evidenceLikelihood: 0, compositeScore: 0, recommendation: 'skip',
      reasons: ['URL could not be parsed into a registrable domain.'],
    };
  }

  const classification = classifySource(domain, targetDomain);
  const partyType = classification === 'first_party' ? 'first_party' : 'third_party';
  const jurisdiction = classifyJurisdiction(domain);
  const reasons = [`Classified as ${classification}.`, `Jurisdiction: ${jurisdiction}.`];

  const authorityBase = CLASSIFICATION_AUTHORITY_BASE[classification] ?? 15;
  const authority = clamp(authorityBase + (looksLikeAuthorityDomain(domain) ? 10 : 0));

  const textHaystack = [candidate.title, candidate.snippet, candidate.name].filter(Boolean).join(' ');
  const nameRelevance = hasTargetContext ? relevanceSignal(textHaystack, targetName || '') : null;
  const organisationRelevance = hasTargetContext ? clamp((nameRelevance / 2) * 100) : null;

  const regulatoryTextHit = REGULATORY_KEYWORDS.test(textHaystack);
  const regulatoryRelevance = clamp(
    (classification === 'regulator' ? 60 : classification === 'professional_body' ? 45 : 0)
    + (regulatoryTextHit ? 40 : 0),
  );

  const commercialRelevance = hasTargetContext
    ? clamp(
      (organisationRelevance * 0.6)
      + (['first_party', 'professional_body', 'regulator', 'news_publication'].includes(classification) ? 30 : 0)
      - (['commercial_directory', 'generic_reference', 'social_platform'].includes(classification) ? 20 : 0),
    )
    : null;

  // Evidence likelihood: how likely is fetching this URL to yield a
  // genuine, citable fact about the SUBJECT the caller cares about (the
  // target in TARGET mode, or the candidate organisation itself in
  // STANDALONE mode) — as opposed to noise.
  const classificationEvidencePenalty = {
    social_platform: 60, commercial_directory: 30, generic_reference: 40, unknown: 30,
  };
  let evidenceLikelihood;
  if (hasTargetContext) {
    evidenceLikelihood = clamp(
      (organisationRelevance * 0.5) + (authority * 0.3) + (commercialRelevance * 0.2)
      - (classificationEvidencePenalty[classification] || 0),
    );
  } else {
    // Standalone: judge the candidate's own intrinsic quality as a source,
    // independent of any target — a generic-reference/job-board/social
    // page is low-value regardless of who linked to it.
    evidenceLikelihood = clamp(authority - (classificationEvidencePenalty[classification] || 0));
  }

  if (classification === 'social_platform') reasons.push('Social platforms are excluded from evidence sourcing.');
  if (classification === 'generic_reference') reasons.push('Generic/encyclopaedic reference — describes a role or industry in the abstract, not this specific organisation.');
  if (classification === 'commercial_directory') reasons.push('Commercial directory/aggregator/review site — low first-hand evidentiary value.');
  if (hasTargetContext && organisationRelevance === 0) reasons.push(`No relevance signal found linking this source to "${targetName}".`);

  const composite = weightedComposite([
    { value: authority, weight: 0.30 },
    { value: evidenceLikelihood, weight: 0.30 },
    { value: organisationRelevance, weight: 0.20 },
    { value: commercialRelevance, weight: 0.10 },
    { value: regulatoryRelevance, weight: 0.10 },
  ]);

  const hardReject = classification === 'social_platform' || (hasTargetContext && organisationRelevance === 0 && classification !== 'first_party' && classification !== 'regulator');
  const recommendation = !hardReject && composite >= 35 ? 'fetch' : 'skip';
  if (hardReject) reasons.push('Hard-rejected: no organisation relevance signal and not an authoritative/first-party source.');

  return {
    url, domain, hostname, classification, partyType, jurisdiction,
    authority, commercialRelevance, regulatoryRelevance, organisationRelevance,
    evidenceLikelihood, compositeScore: composite, recommendation, reasons,
  };
}

module.exports = {
  assessSource,
  classifySource,
  classifyJurisdiction,
  REGULATOR_DOMAINS,
  PROFESSIONAL_BODY_DOMAINS,
  NEWS_PUBLICATION_DOMAINS,
  COMMERCIAL_DIRECTORY_DOMAINS,
  GENERIC_REFERENCE_DOMAINS,
};
