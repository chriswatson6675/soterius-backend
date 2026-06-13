const axios = require('axios');

const WP_VERSION_RE  = /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([0-9.]+)/i;
const GENERATOR_RE   = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i;
const OLD_JQUERY_RE  = /jquery[/-](1\.[0-9]+\.[0-9]+|2\.[0-9]+\.[0-9]+)(?:\.min)?\.js/i;
const VERSION_NUM_RE = /[\d]+\.[\d]+/;

module.exports = async function vulnerableComponentsCheck(domain) {
  let body = '', headers = {};
  try {
    const res = await axios.get(`https://${domain}`, {
      timeout: 10000, maxRedirects: 5, validateStatus: () => true,
      headers: { 'User-Agent': 'Soterius-Scanner/1.0' },
    });
    body    = res.data?.toString() || '';
    headers = res.headers;
  } catch (err) {
    const msg = `Could not fetch page: ${err.message}`;
    return [
      { name: 'No known CVEs in detected software',               status: 'FAIL', points: 0, details: msg, timeToFix: 'N/A' },
      { name: 'Framework and CMS versions not publicly disclosed', status: 'FAIL', details: msg, timeToFix: 'N/A' },
      { name: 'No outdated third-party libraries detected',        status: 'FAIL', details: msg, timeToFix: 'N/A' },
    ];
  }

  // ── Check 1: Known CVEs in detected CMS ──────────────────────────────────────
  const wpMatch   = body.match(WP_VERSION_RE);
  const wpVersion = wpMatch?.[1] ?? null;
  let cveStatus  = 'PASS';
  let cveDetails = 'No CMS or framework versions with known CVEs detected';

  if (wpVersion) {
    const [major, minor] = wpVersion.split('.').map(Number);
    if (major < 6 || (major === 6 && minor < 4)) {
      cveStatus  = 'FAIL';
      cveDetails = `WordPress ${wpVersion} has known CVEs — update to the latest version immediately`;
    } else {
      cveStatus  = 'WARNING';
      cveDetails = `WordPress ${wpVersion} detected in page source — confirm it is up to date`;
    }
  }

  // ── Check 2: Version numbers in server headers / meta ────────────────────────
  const serverHeader = headers['server'] || '';
  const poweredBy    = headers['x-powered-by'] || '';
  const generatorRaw = body.match(GENERATOR_RE)?.[1] ?? '';

  const versionInServer  = serverHeader && VERSION_NUM_RE.test(serverHeader);
  const versionInPowered = poweredBy    && VERSION_NUM_RE.test(poweredBy);

  let disclosureStatus  = 'PASS';
  let disclosureDetails = 'No version numbers found in server headers or page meta';

  if (versionInServer || versionInPowered) {
    disclosureStatus  = 'FAIL';
    const items = [
      versionInServer  && `Server: ${serverHeader}`,
      versionInPowered && `X-Powered-By: ${poweredBy}`,
    ].filter(Boolean);
    disclosureDetails = `Version numbers exposed in HTTP headers (${items.join(', ')}) — remove to reduce targeted attack risk`;
  } else if (serverHeader || poweredBy || generatorRaw) {
    disclosureStatus  = 'WARNING';
    const items = [
      serverHeader && `Server: ${serverHeader}`,
      poweredBy    && `X-Powered-By: ${poweredBy}`,
      generatorRaw && `Generator: ${generatorRaw}`,
    ].filter(Boolean);
    disclosureDetails = `Tech stack visible but no version numbers: ${items.join(', ')} — consider removing`;
  }

  // ── Check 3: Outdated third-party JS libraries ───────────────────────────────
  const jqMatch   = body.match(OLD_JQUERY_RE);
  const jqVersion = jqMatch?.[1] ?? null;
  const libStatus  = jqVersion ? 'FAIL' : 'PASS';
  const libDetails = jqVersion
    ? `jQuery ${jqVersion} detected — pre-3.x versions have known XSS and prototype pollution vulnerabilities`
    : 'No outdated JavaScript library versions detected in page source';

  return [
    {
      name:      'No known CVEs in detected software',
      status:    cveStatus,
      points:    cveStatus === 'PASS' ? 40 : cveStatus === 'WARNING' ? 20 : 0,
      details:   cveDetails,
      timeToFix: cveStatus === 'PASS' ? null : cveStatus === 'WARNING' ? '1 hour' : '2 hours',
    },
    {
      name:      'Framework and CMS versions not publicly disclosed',
      status:    disclosureStatus,
      details:   disclosureDetails,
      timeToFix: disclosureStatus === 'PASS' ? null : '15 minutes',
    },
    {
      name:      'No outdated third-party libraries detected',
      status:    libStatus,
      details:   libDetails,
      timeToFix: libStatus === 'PASS' ? null : '30 minutes',
    },
  ];
};
