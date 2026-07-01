const DOMAIN_RE = /^(?!-)(?:[a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,}$/;

// Blocks localhost, private IP ranges, and internal hostnames
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^0\.0\.0\.0$/,
];

function validateDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  const trimmed = domain.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  if (!DOMAIN_RE.test(trimmed)) return false;
  if (BLOCKED_HOSTS.some(re => re.test(trimmed))) return false;
  return true;
}

module.exports = { validateDomain };
