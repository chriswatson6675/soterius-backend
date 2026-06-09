const axios = require('axios');

// ── Privacy policy detection ──────────────────────────────────────────────────

const PRIVACY_HREF_RE    = /<a\b[^>]+href=["'][^"']*(?:privac|data[-_]?protection|datenschutz|cookie[-_]?polic)[^"']*["']/i;
const PRIVACY_PHRASE_RE  = /privacy\s+(?:policy|notice|statement)|data\s+protection\s+(?:policy|notice|statement)/i;
const PRIVACY_PATH_RE    = /["'](\/[a-z0-9_-]*(?:privac|data-protection|datenschutz|cookie-polic)[a-z0-9_/-]*)["']/i;

function privacyInAnchorText(html) {
  const anchorRE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRE.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (/privacy|data\s+protection|datenschutz/i.test(text)) return true;
  }
  return false;
}

// Strip cookie-consent container HTML before checking for policy links in main body
function stripConsentContainers(html) {
  return html.replace(
    /<(?:div|section|aside|nav|header|footer)\b[^>]*(?:id|class)=["'][^"']*(?:cookie|consent|gdpr|banner|notice)[^"']*["'][^>]*>[\s\S]{0,4000}?<\/(?:div|section|aside|nav|header|footer)>/gi,
    ''
  );
}

function detectPrivacyLink(html) {
  return PRIVACY_HREF_RE.test(html)
    || PRIVACY_PHRASE_RE.test(html)
    || PRIVACY_PATH_RE.test(html)
    || privacyInAnchorText(html);
}

function extractPrivacyUrl(html, domain) {
  const m = html.match(/<a\b[^>]+href=["']([^"']*(?:privac|data[-_]?protection|datenschutz|cookie[-_]?polic)[^"']*)["']/i);
  if (m) {
    const href = m[1];
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//'))      return `https:${href}`;
    if (href.startsWith('/'))       return `https://${domain}${href}`;
    return `https://${domain}/${href}`;
  }
  return null;
}

// ── Cookie consent detection ──────────────────────────────────────────────────

const CONSENT_TEXT_PATTERNS = [
  /cookieconsent/i, /cookie[-_\s]+consent/i, /cookie[-_\s]+banner/i,
  /cookie[-_\s]+notice/i, /consent[-_\s]+banner/i, /OneTrust/i,
  /CookieBot/i, /CookieYes/i, /cookieyes/i, /Quantcast/i,
  /Termly/i, /iubenda/i, /Usercentrics/i, /TrustArc/i,
  /Complianz/i, /CookieLaw/i, /CookieControl/i,
  /accept[\s_-]*(all[\s_-]*)?cookies/i, /reject[\s_-]*(all[\s_-]*)?cookies/i,
];
const CONSENT_CDN_PATTERNS = [
  /cdn[-.]cookieyes\.com/i, /cdn[-.]cookiebot\.com/i, /cdn\.onetrust\.com/i,
  /trustarc\.com/i, /usercentrics\.eu/i, /app\.termly\.io/i,
  /cdn\.iubenda\.com/i, /cookie-script\.com/i,
];

function detectCookieBanner(html) {
  if (/"isCookieBannerEnabled"\s*:\s*false/i.test(html)) return false;
  return CONSENT_TEXT_PATTERNS.some(p => p.test(html))
    || CONSENT_CDN_PATTERNS.some(p => p.test(html));
}

// ── Tracker detection ─────────────────────────────────────────────────────────

const TRACKERS = [
  { name: 'Google Analytics',  pattern: /google-analytics\.com|gtag\('config'/i },
  { name: 'Facebook Pixel',    pattern: /connect\.facebook\.net\/.*fbevents\.js/i },
  { name: 'Hotjar',            pattern: /hotjar\.com\/c\/hotjar/i },
  { name: 'LinkedIn Insight',  pattern: /snap\.licdn\.com/i },
  { name: 'Twitter/X Pixel',   pattern: /static\.ads-twitter\.com/i },
  { name: 'TikTok Pixel',      pattern: /analytics\.tiktok\.com/i },
];

// ── Data rights & DPO detection ───────────────────────────────────────────────

const DATA_RIGHTS_RE = [
  /right\s+to\s+(access|erasure|deletion|portability|object|rectification)/i,
  /data\s+subject\s+rights/i,
  /right\s+to\s+be\s+forgotten/i,
  /article\s+1[34]\b/i,
];

const DPO_MENTION_RE = /data\s+protection\s+officer|dpo\b/i;
const DPO_CONTACT_RE = /(?:data\s+protection\s+officer|dpo)[^<]{0,300}?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/is;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await axios.get(url, {
    timeout: 10000, maxRedirects: 5, validateStatus: () => true,
    headers: { 'User-Agent': 'Soterius-Scanner/1.0' },
  });
  return res.data?.toString() || '';
}

// ── Main export ───────────────────────────────────────────────────────────────

module.exports = async function gdprCheck(domain) {
  // Step 1: fetch homepage
  let homeBody;
  try {
    homeBody = await fetchPage(`https://${domain}`);
  } catch (err) {
    const msg = `Could not load homepage: ${err.message}`;
    return [
      { name: 'Cookies and trackers identified',       status: 'FAIL', details: msg, timeToFix: 'N/A' },
      { name: 'Privacy policy link accessible',        status: 'FAIL', details: msg, timeToFix: '30 minutes' },
      { name: 'Privacy policy content readable',       status: 'FAIL', details: msg, timeToFix: '30 minutes' },
      { name: 'Data subject rights documented',        status: 'FAIL', details: msg, timeToFix: '1 hour' },
      { name: 'DPO contact information provided',      status: 'FAIL', details: msg, timeToFix: '30 minutes' },
      { name: 'Cookie consent banner visible',         status: 'FAIL', details: msg, timeToFix: '1 hour' },
    ];
  }

  // Step 2: detect trackers & cookie banner on homepage
  const trackers    = TRACKERS.filter(t => t.pattern.test(homeBody)).map(t => t.name);
  const hasBanner   = detectCookieBanner(homeBody);

  // Step 3: privacy policy link — check main body first (excluding consent containers)
  const strippedHome = stripConsentContainers(homeBody);
  const policyInMain   = detectPrivacyLink(strippedHome);
  const policyInBanner = !policyInMain && detectPrivacyLink(homeBody);
  const policyFound    = policyInMain || policyInBanner;

  // Step 4: fetch and analyse the privacy policy page
  const policyUrl  = policyFound ? extractPrivacyUrl(homeBody, domain) : null;
  let policyBody   = '';
  let policyIsPdf  = false;
  let policyFailed = false;

  if (policyUrl) {
    if (/\.pdf(\?.*)?$/i.test(policyUrl)) {
      policyIsPdf = true;
    } else {
      try {
        policyBody = await fetchPage(policyUrl);
      } catch {
        policyFailed = true;
      }
    }
  }

  const searchBody = policyBody || homeBody;

  // Step 5: evaluate each check

  // Check 1 — Cookies usage identified
  const cookiesKnown   = trackers.length > 0 || hasBanner;
  const cookieStatus   = cookiesKnown ? 'PASS' : policyFound ? 'WARNING' : 'FAIL';
  const cookieDetails  = trackers.length > 0
    ? `Tracking scripts identified: ${trackers.join(', ')}`
    : hasBanner
      ? 'Cookie consent banner detected — cookies in use are disclosed'
      : policyFound
        ? 'No explicit cookie/tracker scripts found on homepage — check privacy policy for cookie list'
        : 'No cookies, trackers, or consent mechanism detected on homepage';

  // Check 2 — Privacy policy link
  const policyLinkStatus  = !policyFound ? 'FAIL' : policyInMain ? 'PASS' : 'WARNING';
  const policyLinkDetails = !policyFound
    ? 'No privacy policy link found on the homepage — required by GDPR'
    : policyInMain
      ? `Privacy policy link found in page body${policyUrl ? ` (${policyUrl})` : ''}`
      : `Privacy policy link found only within cookie/consent banner — should also appear in main navigation or footer`;

  // Check 3 — Policy content readable
  let policyReadStatus, policyReadDetails;
  if (!policyFound) {
    policyReadStatus  = 'FAIL';
    policyReadDetails = 'No privacy policy found to evaluate';
  } else if (policyIsPdf) {
    policyReadStatus  = 'WARNING';
    policyReadDetails = `Privacy policy is a PDF — machine-readable HTML version is preferred (${policyUrl})`;
  } else if (policyFailed) {
    policyReadStatus  = 'FAIL';
    policyReadDetails = `Privacy policy URL found (${policyUrl}) but the page could not be fetched`;
  } else if (!policyBody) {
    policyReadStatus  = 'WARNING';
    policyReadDetails = 'Privacy policy URL identified but content could not be extracted from homepage context';
  } else {
    policyReadStatus  = 'PASS';
    policyReadDetails = `Privacy policy page is accessible and contains readable content (${policyUrl})`;
  }

  // Check 4 — Data subject rights
  const hasRights      = DATA_RIGHTS_RE.some(p => p.test(searchBody));
  const rightsStatus   = hasRights ? 'PASS' : (policyFound ? 'WARNING' : 'FAIL');
  const rightsDetails  = hasRights
    ? 'Data subject rights language found in the privacy policy'
    : policyFound
      ? 'Privacy policy found but no data subject rights information detected (right to access, erasure, portability, etc.)'
      : 'No data subject rights documentation found';

  // Check 5 — DPO contact
  const dpoMentioned   = DPO_MENTION_RE.test(searchBody);
  const dpoContactM    = searchBody.match(DPO_CONTACT_RE);
  const dpoEmail       = dpoContactM?.[1] ?? null;
  const dpoStatus      = dpoEmail ? 'PASS' : dpoMentioned ? 'WARNING' : 'FAIL';
  const dpoDetails     = dpoEmail
    ? `DPO contact information found: ${dpoEmail}`
    : dpoMentioned
      ? 'Data Protection Officer mentioned but no contact email or form link found'
      : 'No Data Protection Officer information found — required under GDPR Article 37 for many organisations';

  // Check 6 — Cookie consent banner
  const bannerStatus  = hasBanner ? 'PASS' : 'FAIL';
  const bannerDetails = hasBanner
    ? 'Cookie consent mechanism detected on homepage'
    : trackers.length > 0
      ? `Tracking scripts active (${trackers.join(', ')}) but no cookie consent banner detected — GDPR requires opt-in consent before tracking`
      : 'No cookie consent banner detected — required if the site sets any non-essential cookies';

  return [
    { name: 'Cookies and trackers identified',  status: cookieStatus,      details: cookieDetails,      timeToFix: cookieStatus      === 'PASS' ? null : '1 hour'     },
    { name: 'Privacy policy link accessible',   status: policyLinkStatus,  details: policyLinkDetails,  timeToFix: policyLinkStatus  === 'PASS' ? null : '30 minutes' },
    { name: 'Privacy policy content readable',  status: policyReadStatus,  details: policyReadDetails,  timeToFix: policyReadStatus  === 'PASS' ? null : '1 hour'     },
    { name: 'Data subject rights documented',   status: rightsStatus,      details: rightsDetails,      timeToFix: rightsStatus      === 'PASS' ? null : '2 hours'    },
    { name: 'DPO contact information provided', status: dpoStatus,         details: dpoDetails,         timeToFix: dpoStatus         === 'PASS' ? null : '30 minutes' },
    { name: 'Cookie consent banner visible',    status: bannerStatus,      details: bannerDetails,      timeToFix: bannerStatus      === 'PASS' ? null : '1 hour'     },
  ];
};
