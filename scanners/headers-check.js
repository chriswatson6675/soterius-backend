const axios = require('axios');

const HSTS_MIN_MAX_AGE = 15768000; // 6 months in seconds

function parseHstsMaxAge(value) {
  const m = value?.match(/max-age=(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

function cspIsRestrictive(value) {
  return value && !/unsafe-inline|unsafe-eval/i.test(value);
}

function failAll(msg) {
  return [
    { name: 'HSTS present',                                    status: 'FAIL', details: msg, timeToFix: '5 minutes' },
    { name: 'Content Security Policy present and restrictive', status: 'FAIL', details: msg, timeToFix: '30 minutes' },
    { name: 'X-Frame-Options set',                            status: 'FAIL', details: msg, timeToFix: '5 minutes' },
    { name: 'X-Content-Type-Options set',                     status: 'FAIL', details: msg, timeToFix: '5 minutes' },
    { name: 'Referrer-Policy set',                            status: 'FAIL', details: msg, timeToFix: '5 minutes' },
  ];
}

module.exports = async function headersCheck(domain) {
  let h = {};
  try {
    const res = await axios.get(`https://${domain}`, {
      timeout: 10000, maxRedirects: 5, validateStatus: () => true,
      headers: { 'User-Agent': 'Soterius-Scanner/1.0' },
    });
    h = res.headers;
  } catch (err) {
    return failAll(`Could not fetch headers: ${err.message}`);
  }

  const hsts  = h['strict-transport-security'];
  const csp   = h['content-security-policy'];
  const xfo   = h['x-frame-options'];
  const xcto  = h['x-content-type-options'];
  const rp    = h['referrer-policy'];

  const hstsAge = parseHstsMaxAge(hsts);

  return [
    {
      name:   'HSTS present',
      status: !hsts ? 'FAIL' : hstsAge >= HSTS_MIN_MAX_AGE ? 'PASS' : 'WARNING',
      details: !hsts
        ? 'Strict-Transport-Security header missing — users can be silently downgraded to HTTP'
        : hstsAge >= HSTS_MIN_MAX_AGE
          ? `HSTS enabled (max-age=${hstsAge}s)`
          : `HSTS present but max-age ${hstsAge}s is below the recommended ${HSTS_MIN_MAX_AGE}s`,
      timeToFix: !hsts ? '5 minutes' : hstsAge >= HSTS_MIN_MAX_AGE ? null : '5 minutes',
    },
    {
      name:   'Content Security Policy present and restrictive',
      status: !csp ? 'FAIL' : cspIsRestrictive(csp) ? 'PASS' : 'WARNING',
      details: !csp
        ? 'Content-Security-Policy header missing — site is vulnerable to XSS injection'
        : cspIsRestrictive(csp)
          ? 'CSP present and does not permit unsafe-inline or unsafe-eval'
          : "CSP present but allows 'unsafe-inline' or 'unsafe-eval' — weakens XSS protection",
      timeToFix: !csp ? '30 minutes' : cspIsRestrictive(csp) ? null : '30 minutes',
    },
    {
      name:   'X-Frame-Options set',
      status: xfo ? 'PASS' : 'FAIL',
      details: xfo
        ? `X-Frame-Options: ${xfo}`
        : 'X-Frame-Options missing — site may be vulnerable to clickjacking attacks',
      timeToFix: xfo ? null : '5 minutes',
    },
    {
      name:   'X-Content-Type-Options set',
      status: xcto?.toLowerCase() === 'nosniff' ? 'PASS' : xcto ? 'WARNING' : 'FAIL',
      details: !xcto
        ? 'X-Content-Type-Options missing — browser may sniff and misinterpret content types'
        : xcto.toLowerCase() === 'nosniff'
          ? 'X-Content-Type-Options: nosniff'
          : `X-Content-Type-Options: ${xcto} (expected "nosniff")`,
      timeToFix: xcto?.toLowerCase() === 'nosniff' ? null : '5 minutes',
    },
    {
      name:   'Referrer-Policy set',
      status: !rp ? 'FAIL' : /no-referrer|strict-origin/i.test(rp) ? 'PASS' : 'WARNING',
      details: !rp
        ? 'Referrer-Policy missing — full URL may be leaked to third-party services'
        : /no-referrer|strict-origin/i.test(rp)
          ? `Referrer-Policy: ${rp}`
          : `Referrer-Policy: ${rp} — consider a stricter value (no-referrer or strict-origin-when-cross-origin)`,
      timeToFix: !rp ? '5 minutes' : /no-referrer|strict-origin/i.test(rp) ? null : '5 minutes',
    },
  ];
};
