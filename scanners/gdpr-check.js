const axios = require('axios');

// 1. <a href> contains a privacy-related path. Most reliable — catches JS-rendered
//    banners where the URL is baked into static HTML even if the text isn't.
const PRIVACY_HREF_RE = /<a\b[^>]+href=["'][^"']*(?:privac|data[-_]?protection|datenschutz|cookie[-_]?polic)[^"']*["']/i;

// 2. <a> visible text (single level, no nested tags) contains a privacy term.
const PRIVACY_LINK_TEXT_RE = /<a\b[^>]*>[^<]*(?:privacy|data\s+protection|datenschutz|cookie\s+policy)[^<]*<\/a>/i;

// 3. Full phrase anywhere in HTML — covers meta tags and page body text.
//    Uses \s+ (not \s*) so camelCase identifiers like "privacyPolicy" in
//    Squarespace/Wix JSON config blobs do NOT trigger a false positive.
const PRIVACY_PHRASE_RE = /privacy\s+(?:policy|notice|statement)|data\s+protection\s+(?:policy|notice|statement)/i;

// 4. Privacy-related path as a quoted string value anywhere in the document.
//    Catches CookieBot/OneTrust config variables: privacyUrl: "/privacy-policy"
const PRIVACY_PATH_RE = /["'](\/[a-z0-9_-]*(?:privac|data-protection|datenschutz|cookie-polic)[a-z0-9_/-]*)["']/i;

// 5. Extracts inner text of each <a> block (strips nested tags) and checks for
//    privacy terms — handles <span>Privacy</span> inside an anchor.
function privacyInAnchorContent(body) {
  const anchorRE  = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  const stripTags = /<[^>]+>/g;
  let match;
  while ((match = anchorRE.exec(body)) !== null) {
    const text = match[1].replace(stripTags, '').trim();
    if (/privacy|data\s+protection|datenschutz/i.test(text)) return true;
  }
  return false;
}

// Text/class/id patterns in rendered HTML.
// Patterns use [-_\s]+ (one or more separators) so camelCase JS identifiers
// like "isCookieBannerEnabled" in Squarespace/Wix JSON do NOT match.
// Exception: known library names (OneTrust, CookieBot, etc.) are matched as
// whole words because they appear as script IDs and function names, not prose.
const COOKIE_CONSENT_TEXT_PATTERNS = [
  /cookieconsent/i,
  /cookie[-_\s]+consent/i,
  /cookie[-_\s]+banner/i,
  /cookie[-_\s]+notice/i,
  /cookie[-_\s]+popup/i,
  /cookie[-_\s]+modal/i,
  /consent[-_\s]+banner/i,
  /consent[-_\s]+manager/i,
  /OneTrust/i,
  /CookieBot/i,
  /CookieYes/i,
  /cookieyes/i,
  /Quantcast/i,
  /Termly/i,
  /iubenda/i,
  /Usercentrics/i,
  /TrustArc/i,
  /Complianz/i,
  /CookieLaw/i,
  /CookieControl/i,
  /borlabs[\s_-]*cookie/i,
  /accept[\s_-]*(all[\s_-]*)?cookies/i,
  /reject[\s_-]*(all[\s_-]*)?cookies/i,
];

// CDN/script src patterns — catches JS-injected banners that leave no HTML in
// the static source. Matches the src attribute of consent library script tags.
const COOKIE_CONSENT_CDN_PATTERNS = [
  /cdn[-.]cookieyes\.com/i,
  /cdn[-.]cookiebot\.com/i,
  /cdn\.onetrust\.com/i,
  /cookiepro\.com/i,
  /trustarc\.com/i,
  /usercentrics\.eu/i,
  /app\.termly\.io/i,
  /cdn\.iubenda\.com/i,
  /cookie-script\.com/i,
  /cookielaw\.org/i,
  /cookie-cdn\.cookiepro\.com/i,
];

function detectCookieConsent(body) {
  // Squarespace/Wix embed JSON config with cookie banner fields even when the
  // feature is disabled.  If the platform explicitly says it's disabled, bail
  // early before any pattern matching runs.
  const squarespaceDisabled = /"isCookieBannerEnabled"\s*:\s*false/i.test(body);
  if (squarespaceDisabled) return false;

  if (COOKIE_CONSENT_TEXT_PATTERNS.some(p => p.test(body))) return true;
  if (COOKIE_CONSENT_CDN_PATTERNS.some(p => p.test(body))) return true;
  return false;
}

const TRACKING_PATTERNS = [
  { name: 'Google Analytics', pattern: /google-analytics\.com|gtag\('config'/i },
  { name: 'Facebook Pixel', pattern: /connect\.facebook\.net\/.*fbevents\.js/i },
  { name: 'Hotjar', pattern: /hotjar\.com\/c\/hotjar/i },
  { name: 'LinkedIn Insight', pattern: /snap\.licdn\.com/i },
  { name: 'Twitter/X Pixel', pattern: /static\.ads-twitter\.com/i },
  { name: 'TikTok Pixel', pattern: /analytics\.tiktok\.com/i },
];

// Deliberately strict — only GDPR-specific legal language qualifies.
// Removed: "unsubscribe" (email footers) and "opt-out" (JS identifiers,
// marketing copy) — both caused false positives on sites with no actual
// data rights information.
const DATA_RIGHTS_PATTERNS = [
  /right\s+to\s+(access|erasure|deletion|portability|object|rectification)/i,
  /data\s+subject\s+rights/i,
  /right\s+to\s+be\s+forgotten/i,
  /article\s+1[34]\b/i,
];

async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': 'SecureVault-Scanner/1.0' },
  });
  return response.data?.toString() || '';
}

// Extracts the href from the first privacy-related <a> tag found in the page.
// Returns a fully-qualified URL, or null if none is found.
function extractPrivacyPolicyUrl(body, domain) {
  // Try to pull an href that looks like a privacy path directly.
  const hrefMatch = body.match(/<a\b[^>]+href=["']([^"']*(?:privac|data[-_]?protection|datenschutz|cookie[-_]?polic)[^"']*)["']/i);
  if (hrefMatch) {
    const href = hrefMatch[1];
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return `https://${domain}${href}`;
    return `https://${domain}/${href}`;
  }

  // Fall back: anchor whose inner text contains a privacy term.
  const anchorRE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const stripTags = /<[^>]+>/g;
  let match;
  while ((match = anchorRE.exec(body)) !== null) {
    const text = match[2].replace(stripTags, '').trim();
    if (!/privacy|data\s+protection|datenschutz/i.test(text)) continue;
    const attrHrefMatch = match[1].match(/href=["']([^"']+)["']/i);
    if (!attrHrefMatch) continue;
    const href = attrHrefMatch[1];
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return `https://${domain}${href}`;
    return `https://${domain}/${href}`;
  }

  return null;
}

function isPDF(url) {
  return /\.pdf(\?.*)?$/i.test(url);
}

async function checkPrivacyPolicyContent(domain, homepageBody) {
  const url = extractPrivacyPolicyUrl(homepageBody, domain);

  if (!url) {
    return { checked: false, hasDataRights: false, reason: 'no privacy policy URL found', url: null };
  }

  if (isPDF(url)) {
    return { checked: false, hasDataRights: false, reason: 'PDF — manual review required', url };
  }

  let policyBody;
  try {
    policyBody = await fetchPage(url);
  } catch {
    return { checked: false, hasDataRights: false, reason: 'failed to fetch privacy policy page', url };
  }

  const hasDataRights = DATA_RIGHTS_PATTERNS.some(p => p.test(policyBody));
  return { checked: true, hasDataRights, reason: hasDataRights ? 'found in privacy policy' : 'not found in privacy policy', url };
}

function detectPrivacyPolicy(body) {
  const byHref       = PRIVACY_HREF_RE.test(body);
  const byLinkText   = PRIVACY_LINK_TEXT_RE.test(body);
  const byPhrase     = PRIVACY_PHRASE_RE.test(body);
  const byPath       = PRIVACY_PATH_RE.test(body);
  const byAnchorInner = !byHref && !byLinkText && privacyInAnchorContent(body);

  const found = byHref || byLinkText || byPhrase || byPath || byAnchorInner;

  let method = null;
  if      (byHref)        method = 'href attribute';
  else if (byLinkText)    method = 'link text';
  else if (byPhrase)      method = 'page text';
  else if (byPath)        method = 'script / config path';
  else if (byAnchorInner) method = 'anchor inner content';

  return { found, method };
}

async function gdprCheck(domain) {
  const body = await fetchPage(`https://${domain}`);

  const privacy          = detectPrivacyPolicy(body);
  const hasCookieConsent = detectCookieConsent(body);
  const trackers         = TRACKING_PATTERNS.filter(t => t.pattern.test(body)).map(t => t.name);

  const policyCheck = await checkPrivacyPolicyContent(domain, body);
  // Also accept data rights found directly on the homepage (rare but valid).
  const hasDataRights = policyCheck.hasDataRights || DATA_RIGHTS_PATTERNS.some(p => p.test(body));

  const issues = [];
  if (!privacy.found)    issues.push('No privacy policy link detected on homepage');
  if (!hasCookieConsent) issues.push('No active cookie consent mechanism — GDPR requires opt-in before tracking');
  if (trackers.length > 0 && !hasCookieConsent) issues.push(`Tracking scripts active without consent banner (GDPR violation): ${trackers.join(', ')}`);
  if (policyCheck.reason === 'PDF — manual review required') {
    issues.push('Privacy policy is a PDF — data subject rights require manual review');
  } else if (!hasDataRights) {
    issues.push('No data subject rights information detected');
  }

  // Missing cookie consent is a legal fail regardless of other issue count.
  const status = !hasCookieConsent ? 'fail' : issues.length === 0 ? 'pass' : 'warn';

  return {
    module: 'gdpr',
    status,
    details: {
      privacyPolicy: privacy.found,
      privacyDetectedBy: privacy.method,
      cookieConsent: hasCookieConsent,
      trackers,
      dataRightsPresent: hasDataRights,
      privacyPolicyUrl: policyCheck.url,
      privacyPolicyChecked: policyCheck.checked,
      privacyCheckReason: policyCheck.reason,
    },
    issues,
  };
}

module.exports = gdprCheck;
