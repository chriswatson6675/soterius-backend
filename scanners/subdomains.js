const axios = require('axios');

async function subdomains(domain) {
  const url = `https://crt.sh/?q=%.${domain}&output=json`;

  const response = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'SecureVault-Scanner/1.0' },
  });

  const entries = Array.isArray(response.data) ? response.data : [];

  const seen = new Set();
  const found = [];

  for (const entry of entries) {
    const names = (entry.name_value || '').split('\n');
    for (const name of names) {
      const clean = name.trim().toLowerCase().replace(/^\*\./, '');
      if (clean && clean.endsWith(domain) && !seen.has(clean)) {
        seen.add(clean);
        found.push({
          name: clean,
          issuer: entry.issuer_name || null,
          loggedAt: entry.entry_timestamp || null,
        });
      }
    }
  }

  found.sort((a, b) => a.name.localeCompare(b.name));

  return {
    module: 'subdomains',
    status: 'pass',
    details: {
      source: 'crt.sh (certificate transparency)',
      count: found.length,
      subdomains: found,
    },
    issues: [],
  };
}

module.exports = subdomains;
