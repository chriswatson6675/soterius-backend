'use strict';

/**
 * Normalise a domain string to its bare apex form.
 * Strips scheme, www., trailing slashes and paths.
 * Returns lowercase.
 *
 * Examples:
 *   https://www.Example.com/about  →  example.com
 *   http://firm.co.uk              →  firm.co.uk
 */
function normaliseDomain(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '');
  d = d.replace(/^www\./i, '');
  d = d.split('/')[0];
  d = d.split('?')[0];
  d = d.split('#')[0];
  return d;
}

/**
 * Normalise a firm name for fuzzy comparison.
 * Lowercases, strips punctuation and common legal suffixes, collapses whitespace.
 */
function normaliseFirmName(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/\b(llp|ltd|limited|solicitors?|law|legal|&|and)\b/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein edit distance between two strings.
 * O(m*n) — fine for the short strings used here (domain names, firm names).
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns true if domain looks like a parked / for-sale page.
 * Checks HTML body for sale phrases and thin content.
 */
function isParkedPage(html) {
  if (!html || typeof html !== 'string') return false;
  const lower = html.toLowerCase();
  const salePatterns = [
    'this domain is for sale',
    'domain for sale',
    'buy this domain',
    'this domain may be for sale',
    'parked by',
    'domain parking',
    'hugedomains',
    'sedo.com',
    'afternic.com',
    'dan.com/buy',
  ];
  if (salePatterns.some(p => lower.includes(p))) return true;
  const stripped = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return stripped.length < 150;
}

module.exports = { normaliseDomain, normaliseFirmName, levenshtein, isParkedPage };
