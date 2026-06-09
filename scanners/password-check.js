const axios = require('axios');

const LOGIN_PATHS = [
  '/login', '/signin', '/wp-login.php', '/admin',
  '/user/login', '/account/login', '/members/login',
];

const CSRF_RE        = /\bname=["'][^"']*(?:csrf|_token|nonce|authenticity_token|__requestverificationtoken)[^"']*["']/i;
const CAPTCHA_RE     = /recaptcha|hcaptcha|turnstile|captcha/i;
const RATE_HEADERS   = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after', 'ratelimit-limit'];
const PASSWORD_RE    = /(?:password|passphrase)\s+(?:must|should|requires?|needs?)|minimum.{0,20}\d+.{0,20}(?:character|digit|letter)/i;
const FORM_ACTION_RE = /<form\b[^>]*action=["'](https?:[^"']+)["']/gi;

async function fetchQuiet(url) {
  try {
    return await axios.get(url, {
      timeout: 7000, maxRedirects: 3, validateStatus: () => true,
      headers: { 'User-Agent': 'Soterius-Scanner/1.0' },
    });
  } catch {
    return null;
  }
}

function hasForms(html) {
  return /<form\b/i.test(html);
}

module.exports = async function passwordSecurityCheck(domain) {
  // Fetch homepage and all common login paths in parallel
  const [homeRes, ...loginResults] = await Promise.all([
    fetchQuiet(`https://${domain}`),
    ...LOGIN_PATHS.map(p => fetchQuiet(`https://${domain}${p}`)),
  ]);

  const homeBody    = homeRes?.data?.toString()    || '';
  const homeHeaders = homeRes?.headers             || {};

  // Pick first login page that has a form and looks login-related
  const loginRes = loginResults.find(r => {
    if (!r || r.status >= 400) return false;
    const b = r.data?.toString() || '';
    return hasForms(b) && /password|login|sign.?in/i.test(b);
  });
  const loginBody    = loginRes?.data?.toString() || '';
  const loginHeaders = loginRes?.headers          || {};

  const scanBody    = loginBody || homeBody;
  const allHeaders  = { ...homeHeaders, ...loginHeaders };

  // ── Check 1: Login form uses HTTPS ───────────────────────────────────────────
  let httpsStatus  = 'PASS';
  let httpsDetails = loginRes
    ? `Login page found — served over HTTPS`
    : 'No login page found at common paths — login security could not be verified';

  if (!loginRes) {
    httpsStatus = 'WARNING';
  } else {
    let m;
    const insecure = [];
    FORM_ACTION_RE.lastIndex = 0;
    while ((m = FORM_ACTION_RE.exec(loginBody)) !== null) {
      if (/^http:/.test(m[1])) insecure.push(m[1]);
    }
    if (insecure.length > 0) {
      httpsStatus  = 'FAIL';
      httpsDetails = `Login form submits credentials over HTTP — credentials sent in plaintext`;
    }
  }

  // ── Check 2: CSRF tokens present ─────────────────────────────────────────────
  const forms    = hasForms(scanBody);
  const hasCsrf  = CSRF_RE.test(scanBody);

  let csrfStatus  = 'PASS';
  let csrfDetails = 'CSRF token detected in form fields';
  if (!forms) {
    csrfStatus  = 'WARNING';
    csrfDetails = 'No forms found on scanned pages — CSRF protection could not be verified';
  } else if (!hasCsrf) {
    csrfStatus  = 'WARNING';
    csrfDetails = 'Forms present but no CSRF tokens detected — may rely on SameSite cookies or a JS-based mechanism';
  }

  // ── Check 3: Password requirements documented ─────────────────────────────────
  const hasReqs = PASSWORD_RE.test(scanBody);
  let passStatus  = loginRes ? (hasReqs ? 'PASS' : 'WARNING') : 'WARNING';
  let passDetails = !loginRes
    ? 'No login page found — password requirements could not be verified'
    : hasReqs
      ? 'Password requirement text found on the login or registration page'
      : 'Login page found but no password requirement text detected — requirements may not be communicated to users';

  // ── Check 4: Rate limiting on login ──────────────────────────────────────────
  const hasRateHeaders = RATE_HEADERS.some(h => allHeaders[h]);
  const hasCaptcha     = CAPTCHA_RE.test(scanBody);

  let rateStatus  = 'PASS';
  let rateDetails = '';
  if (hasRateHeaders) {
    const found = RATE_HEADERS.filter(h => allHeaders[h]);
    rateDetails = `Rate-limiting headers detected: ${found.join(', ')}`;
  } else if (hasCaptcha) {
    rateStatus  = 'WARNING';
    rateDetails = 'CAPTCHA detected (helps prevent automated attacks) but no HTTP rate-limit headers present';
  } else {
    rateStatus  = 'WARNING';
    rateDetails = 'No rate-limiting headers or CAPTCHA detected — brute-force protection could not be confirmed remotely';
  }

  return [
    {
      name:      'Login form transmitted over HTTPS',
      status:    httpsStatus,
      details:   httpsDetails,
      timeToFix: httpsStatus === 'PASS' ? null : httpsStatus === 'WARNING' ? '1 hour' : '30 minutes',
    },
    {
      name:      'CSRF protection present on forms',
      status:    csrfStatus,
      details:   csrfDetails,
      timeToFix: csrfStatus === 'PASS' ? null : '1 hour',
    },
    {
      name:      'Password requirements documented',
      status:    passStatus,
      details:   passDetails,
      timeToFix: passStatus === 'PASS' ? null : '30 minutes',
    },
    {
      name:      'Rate limiting on authentication endpoints',
      status:    rateStatus,
      details:   rateDetails,
      timeToFix: rateStatus === 'PASS' ? null : '2 hours',
    },
  ];
};
