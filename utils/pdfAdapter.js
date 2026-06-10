// Maps the current 5-scanner frontend format → the 7-key format expected by generatePDF.
// Removed scanners (ports, subdomains) are simply omitted; generatePDF iterates only
// the keys present so missing keys produce no output rather than errors.

const SCANNER_NAME_TO_PDF_KEY = {
  'SSL/TLS Encryption':      'ssl',
  'Security Headers':        'headers',
  'Email Security':          'dns',      // pdf-generator uses 'dns' for email auth
  'Vulnerable Components':   'tech',     // pdf-generator uses 'tech' for vuln components
  'GDPR / Cookie Compliance':'gdpr',
};

// rawScanResults: [{ name, score, checks: [{ name, status, details, timeToFix }] }]
// Returns:        { ssl: { status, issues, details }, headers: { ... }, ... }
function adaptScannersForPDF(rawScanResults) {
  if (!Array.isArray(rawScanResults)) return {};

  const adapted = {};

  for (const scanner of rawScanResults) {
    const key = SCANNER_NAME_TO_PDF_KEY[scanner.name];
    if (!key) continue;

    const checks = scanner.checks || [];

    const hasFail = checks.some(c => c.status === 'FAIL');
    const hasWarn = checks.some(c => c.status === 'WARNING');

    const status = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

    const issues = checks
      .filter(c => c.status !== 'PASS')
      .map(c => [c.name, c.details].filter(Boolean).join(': '));

    adapted[key] = { status, issues, details: {} };
  }

  return adapted;
}

module.exports = { adaptScannersForPDF };
