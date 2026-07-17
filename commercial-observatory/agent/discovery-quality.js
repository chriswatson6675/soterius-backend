'use strict';

// Discovery Quality Gate (Part 5) — deterministic assessment of whether a
// raw discovered name/link is a plausible organisation or institution at
// all, applied before anything becomes a discovery, a relationship
// candidate, or a linked-organisation entry. Two failure modes this exists
// to stop, both observed in a real Compliance Office investigation:
//
//   1. UI/navigation/legal/cookie noise masquerading as an "organisation"
//      ("Follow this company", "© Crown copyright", "here",
//      "www.aboutcookies.org").
//   2. An identifier/code or a raw URL used AS IF it were the
//      organisation's name (e.g. an anchor whose text is the ICO
//      registration number "ZA075078", or the bare URL
//      "https://www.clio.com/uk/") — never trusted verbatim as a name.
//      Where the surrounding first-party text makes the link's PURPOSE
//      explicit (e.g. a "sub-processors" list), a plausible name is
//      derived from the domain instead — never from the raw label.

const REJECT_EXACT_PHRASES = new Set([
  'follow this company', 'file for this company', 'tell us what you think of this service',
  'is there anything wrong with this page', 'developers', 'policies', 'cookies', 'contact us',
  'accessibility statement', 'built by companies house', 'sign in', 'sign in / register', 'register',
  'here', 'click here', 'read more', 'learn more', 'find out more', 'get in touch',
  'terms and conditions', 'terms and conditions of sale', 'privacy and cookies policy',
  'privacy policy', 'cookie policy', 'search', 'advanced company search', 'shop', 'connect', 'info',
]);

const VENDOR_CONTEXT_KEYWORDS = /\b(sub-?processors?|suppliers?|vendors?|technology partners?|service providers?)\b/i;

function isRawUrlLabel(text) {
  return /^https?:\/\//i.test(text) || /^www\./i.test(text);
}

function isIdentifierShaped(text) {
  // Short alphanumeric code with at least one digit — a registration
  // number, reference code, etc. — never a plausible organisation name.
  // A pure-letters short acronym (e.g. "FCA") is NOT rejected here; known
  // acronyms are handled by entity-detection.js's own KNOWN_BODIES
  // vocabulary, a much stronger signal than this generic shape check.
  return /^[A-Z0-9]{4,15}$/.test(text) && /\d/.test(text);
}

function hostnameOf(urlOrDomain) {
  if (!urlOrDomain) return null;
  try { return new URL(urlOrDomain).hostname.replace(/^www\./, ''); } catch { /* not a full URL */ }
  return urlOrDomain.replace(/^www\./, '');
}

function domainToPlausibleName(domainOrUrl) {
  const host = hostnameOf(domainOrUrl);
  if (!host) return null;
  const core = host.split('.')[0];
  if (!core || core.length < 2) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/**
 * extractProximityWindow(fullText, needle, window) — the same
 * "surrounding text" discipline entity-detection.js already uses
 * (getSentenceContaining/extractWindow), reused here so the vendor-context
 * check only ever looks at text genuinely near the candidate, not the
 * whole page (which could contain "sub-processors" anywhere and falsely
 * legitimise an unrelated link elsewhere on the same page).
 */
function extractProximityWindow(fullText, needle, window = 300) {
  if (!fullText || !needle) return '';
  const index = fullText.indexOf(needle);
  if (index === -1) return '';
  return fullText.slice(Math.max(0, index - window), Math.min(fullText.length, index + needle.length + window));
}

/**
 * assessDiscoveryCandidate({ rawName, domain, url, pageText }) ->
 *   { accepted, category, name, reason }
 *
 * `pageText`: the full visible text of the page the candidate was found
 * on — used only to compute a narrow proximity window around `rawName`
 * for the vendor-context check above; never used to invent facts beyond
 * that narrow purpose.
 */
function assessDiscoveryCandidate({ rawName, domain, url, pageText = '' } = {}) {
  const trimmed = (rawName || '').trim();
  if (!trimmed) return { accepted: false, category: 'unclassified', name: null, reason: 'Empty candidate name.' };

  const lower = trimmed.toLowerCase();
  if (REJECT_EXACT_PHRASES.has(lower)) {
    return { accepted: false, category: 'utility_link', name: null, reason: `Known non-entity UI/navigation/legal phrase: "${trimmed}".` };
  }
  if (/^©/.test(trimmed) || /crown copyright/i.test(trimmed)) {
    return { accepted: false, category: 'legal_footer_link', name: null, reason: 'Copyright notice, not an organisation.' };
  }
  if (/link opens in (a )?new (window|tab)/i.test(trimmed)) {
    return { accepted: false, category: 'utility_link', name: null, reason: 'UI affordance text, not an organisation name.' };
  }
  if (/aboutcookies\.org|allaboutcookies\.org/i.test(trimmed) || /aboutcookies\.org|allaboutcookies\.org/i.test(domain || '')) {
    return { accepted: false, category: 'cookie_resource', name: null, reason: 'Generic cookie-information resource, not an organisation.' };
  }

  const rawUrlLabel = isRawUrlLabel(trimmed);
  const identifierShaped = isIdentifierShaped(trimmed);
  if (rawUrlLabel || identifierShaped) {
    const window = extractProximityWindow(pageText, trimmed);
    if (VENDOR_CONTEXT_KEYWORDS.test(window)) {
      const derivedName = domainToPlausibleName(domain || url || trimmed);
      if (derivedName) {
        return {
          accepted: true, category: 'technology_vendor', name: derivedName,
          reason: 'Named in a first-party sub-processor/supplier/vendor list; name derived from the domain, not the raw link label.',
        };
      }
    }
    return {
      accepted: false, category: rawUrlLabel ? 'platform_endpoint' : 'identifier_not_a_name', name: null,
      reason: rawUrlLabel ? 'Raw URL used as the anchor label, not a resolved organisation name.' : 'Identifier/reference-code-shaped token, not an organisation name.',
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return { accepted: false, category: 'identifier_not_a_name', name: null, reason: 'Purely numeric token, not an organisation name.' };
  }

  // Passed every rejection check — a plausible organisation-shaped name.
  // Callers with a stronger classification signal (e.g. entity-detection's
  // KNOWN_BODIES vocabulary) should prefer their own category; this is a
  // conservative fallback for names this gate has no specific reason to
  // reject.
  return { accepted: true, category: 'unclassified_organisation', name: trimmed, reason: 'No rejection pattern matched; treated as a plausible organisation name.' };
}

module.exports = { assessDiscoveryCandidate, domainToPlausibleName, extractProximityWindow };
