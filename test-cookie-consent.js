/**
 * test-cookie-consent.js — before/after test for cookie consent detection.
 * Tests detection directly against the live page without needing the backend running.
 *
 * Usage:  node test-cookie-consent.js
 */

const axios = require('axios');

// ── BEFORE: the old pattern list ──────────────────────────────────────────
const OLD_PATTERNS = [
  /cookieconsent/i, /cookie\s*consent/i, /cookie\s*banner/i,
  /cookie\s*notice/i, /gdpr/i, /OneTrust/i, /CookieBot/i, /Quantcast/i,
];

// ── AFTER: the new expanded detection ─────────────────────────────────────
const NEW_TEXT_PATTERNS = [
  /cookieconsent/i, /cookie[\s_-]*consent/i, /cookie[\s_-]*banner/i,
  /cookie[\s_-]*notice/i, /cookie[\s_-]*popup/i, /cookie[\s_-]*modal/i,
  /consent[\s_-]*banner/i, /consent[\s_-]*manager/i,
  /OneTrust/i, /CookieBot/i, /CookieYes/i, /cookieyes/i, /Quantcast/i,
  /Termly/i, /iubenda/i, /Usercentrics/i, /TrustArc/i, /Complianz/i,
  /CookieLaw/i, /CookieControl/i, /borlabs[\s_-]*cookie/i,
  /accept[\s_-]*(all[\s_-]*)?cookies/i, /reject[\s_-]*(all[\s_-]*)?cookies/i,
];
const NEW_CDN_PATTERNS = [
  /cdn[-.]cookieyes\.com/i, /cdn[-.]cookiebot\.com/i, /cdn\.onetrust\.com/i,
  /cookiepro\.com/i, /trustarc\.com/i, /usercentrics\.eu/i,
  /app\.termly\.io/i, /cdn\.iubenda\.com/i, /cookie-script\.com/i,
  /cookielaw\.org/i,
];

function detectOld(body) { return OLD_PATTERNS.some(p => p.test(body)); }
function detectNew(body) {
  if (NEW_TEXT_PATTERNS.some(p => p.test(body))) return { found: true, via: 'text/class match' };
  const cdnMatch = NEW_CDN_PATTERNS.find(p => p.test(body));
  if (cdnMatch) return { found: true, via: 'CDN script src: ' + (body.match(/src="([^"]*cdn[-.]cookieyes[^"]*)"/) || body.match(/src="([^"]*cookiebot[^"]*)"/) || ['', 'consent CDN'])[1] };
  return { found: false };
}

const DOMAINS = [
  'zensec.co.uk',         // CookieYes — was falsely showing "no consent"
  'boneandpayne.co.uk',   // Known no consent banner — should still show false
  'github.com',           // No cookie banner expected
];

async function fetchBody(domain) {
  const { data } = await axios.get(`https://${domain}`, {
    timeout: 15000, maxRedirects: 5, validateStatus: () => true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  return data.toString();
}

async function run() {
  console.log('Cookie Consent Detection — Before/After Test');
  console.log('═'.repeat(60));

  for (const domain of DOMAINS) {
    process.stdout.write(`\nFetching ${domain} ... `);
    let body;
    try {
      body = await fetchBody(domain);
      console.log(`${body.length.toLocaleString()} bytes`);
    } catch (err) {
      console.log(`ERROR — ${err.message}`);
      continue;
    }

    const oldResult = detectOld(body);
    const newResult = detectNew(body);

    const oldLabel = oldResult ? '✅ DETECTED' : '❌ NOT DETECTED';
    const newLabel = newResult.found ? `✅ DETECTED (${newResult.via})` : '❌ NOT DETECTED';
    const changed = oldResult !== newResult.found;

    console.log(`  BEFORE: Cookie consent ${oldLabel}`);
    console.log(`  AFTER:  Cookie consent ${newLabel}`);
    if (changed) {
      console.log(`  ⚡ CHANGED — ${oldResult ? 'false positive removed' : 'false negative fixed'}`);
    } else {
      console.log(`  ─ No change (result was already correct)`);
    }

    // Show the matching evidence
    if (newResult.found) {
      const matchedText = NEW_TEXT_PATTERNS.find(p => p.test(body));
      const matchedCDN  = NEW_CDN_PATTERNS.find(p => p.test(body));
      if (matchedText) {
        const snippet = body.match(matchedText)?.[0];
        console.log(`  Evidence (text): "${snippet}"`);
      }
      if (matchedCDN) {
        const snippet = body.match(/src="([^"]*(?:cookieyes|cookiebot|onetrust|termly|iubenda)[^"]*)"/i)?.[1];
        console.log(`  Evidence (CDN):  ${snippet || 'script tag found'}`);
      }
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('Test complete.');
}

run().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
