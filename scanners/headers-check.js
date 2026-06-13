const axios = require('axios');

const HSTS_MIN_MAX_AGE = 15768000; // 6 months in seconds

function parseHstsMaxAge(value) {
  const m = value?.match(/max-age=(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

// Points earned per status given the maximum for that check (WARN = 50% of PASS)
function pts(status, passMax) {
  if (status === 'PASS') return passMax;
  if (status === 'WARNING') return Math.round(passMax * 0.5);
  return 0;
}

function failAll(msg) {
  return [
    { name: 'HSTS present',                 status: 'FAIL', points: 0, details: msg, timeToFix: '5 minutes' },
    { name: 'Content Security Policy set',  status: 'FAIL', points: 0, details: msg, timeToFix: '5 minutes' },
    { name: 'X-Frame-Options set',          status: 'FAIL', points: 0, details: msg, timeToFix: '5 minutes' },
    { name: 'X-Content-Type-Options set',   status: 'FAIL', points: 0, details: msg, timeToFix: '5 minutes' },
    { name: 'Referrer-Policy set',          status: 'FAIL', points: 0, details: msg, timeToFix: '5 minutes' },
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

  const hsts = h['strict-transport-security'];
  const csp  = h['content-security-policy'];
  const xfo  = h['x-frame-options'];
  const xcto = h['x-content-type-options'];
  const rp   = h['referrer-policy'];

  const hstsAge = parseHstsMaxAge(hsts);

  // HSTS status
  const hstsStatus = !hsts ? 'FAIL' : hstsAge >= HSTS_MIN_MAX_AGE ? 'PASS' : 'WARNING';

  // CSP status: FAIL if absent; WARNING if present but has unsafe directives or wildcards
  const cspHasUnsafe = csp && /'unsafe-inline'|'unsafe-eval'|\bdata:\b/i.test(csp);
  const cspStatus = !csp ? 'FAIL' : cspHasUnsafe ? 'WARNING' : 'PASS';

  // X-Frame-Options status
  const xfoStatus = xfo ? 'PASS' : 'FAIL';

  // X-Content-Type-Options status
  const xctoStatus = xcto?.toLowerCase() === 'nosniff' ? 'PASS' : xcto ? 'WARNING' : 'FAIL';

  // Referrer-Policy status
  const rpStatus = !rp ? 'FAIL' : /no-referrer|strict-origin/i.test(rp) ? 'PASS' : 'WARNING';

  return [
    {
      name:    'HSTS present',
      status:  hstsStatus,
      points:  pts(hstsStatus, 15),
      details: !hsts
        ? 'Strict-Transport-Security header missing — users can be silently downgraded to HTTP'
        : hstsAge >= HSTS_MIN_MAX_AGE
          ? `HSTS enabled (max-age=${hstsAge}s)`
          : `HSTS present but max-age ${hstsAge}s is below the recommended ${HSTS_MIN_MAX_AGE}s`,
      timeToFix: !hsts ? '5 minutes' : hstsAge >= HSTS_MIN_MAX_AGE ? null : '5 minutes',
    },
    {
      name:    'Content Security Policy set',
      status:  cspStatus,
      points:  pts(cspStatus, 13),
      details: !csp
        ? 'Content-Security-Policy header missing — browsers have no instruction to block malicious injected content'
        : cspHasUnsafe
          ? `CSP present but contains unsafe directives — consider removing 'unsafe-inline' and 'unsafe-eval'`
          : `Content-Security-Policy configured`,
      timeToFix: cspStatus === 'PASS' ? null : '30 minutes',
    },
    {
      name:    'X-Frame-Options set',
      status:  xfoStatus,
      points:  pts(xfoStatus, 10),
      details: xfo
        ? `X-Frame-Options: ${xfo}`
        : 'X-Frame-Options missing — site may be vulnerable to clickjacking attacks',
      timeToFix: xfo ? null : '5 minutes',
    },
    {
      name:    'X-Content-Type-Options set',
      status:  xctoStatus,
      points:  pts(xctoStatus, 8),
      details: !xcto
        ? 'X-Content-Type-Options missing — browser may sniff and misinterpret content types'
        : xcto.toLowerCase() === 'nosniff'
          ? 'X-Content-Type-Options: nosniff'
          : `X-Content-Type-Options: ${xcto} (expected "nosniff")`,
      timeToFix: xctoStatus === 'PASS' ? null : '5 minutes',
    },
    {
      name:    'Referrer-Policy set',
      status:  rpStatus,
      points:  pts(rpStatus, 4),
      details: !rp
        ? 'Referrer-Policy missing — full URL may be leaked to third-party services'
        : /no-referrer|strict-origin/i.test(rp)
          ? `Referrer-Policy: ${rp}`
          : `Referrer-Policy: ${rp} — consider a stricter value (no-referrer or strict-origin-when-cross-origin)`,
      timeToFix: rpStatus === 'PASS' ? null : '5 minutes',
    },
  ];
};
