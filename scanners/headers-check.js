const axios = require('axios');

const REQUIRED_HEADERS = [
  {
    name: 'content-security-policy',
    label: 'Content-Security-Policy',
    critical: true,
  },
  {
    name: 'strict-transport-security',
    label: 'Strict-Transport-Security (HSTS)',
    critical: true,
  },
  {
    name: 'x-frame-options',
    label: 'X-Frame-Options',
    critical: false,
  },
  {
    name: 'x-content-type-options',
    label: 'X-Content-Type-Options',
    critical: false,
  },
  {
    name: 'referrer-policy',
    label: 'Referrer-Policy',
    critical: false,
  },
  {
    name: 'permissions-policy',
    label: 'Permissions-Policy',
    critical: false,
  },
];

async function headersCheck(domain) {
  const url = `https://${domain}`;

  const response = await axios.get(url, {
    timeout: 10000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': 'SecureVault-Scanner/1.0' },
  });

  const receivedHeaders = response.headers;
  const present = [];
  const missing = [];

  for (const header of REQUIRED_HEADERS) {
    const value = receivedHeaders[header.name];
    if (value) {
      present.push({ name: header.label, value });
    } else {
      missing.push({ name: header.label, critical: header.critical });
    }
  }

  const criticalMissing = missing.filter(h => h.critical);
  const status = criticalMissing.length > 0 ? 'fail' : missing.length > 0 ? 'warn' : 'pass';

  return {
    module: 'headers',
    status,
    details: {
      present,
      missing,
      score: `${present.length}/${REQUIRED_HEADERS.length}`,
    },
    issues: missing.map(h => `Missing header: ${h.name}${h.critical ? ' (critical)' : ''}`),
  };
}

module.exports = headersCheck;
