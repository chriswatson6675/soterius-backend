'use strict';

// URL normalisation and safety policy for the Commercial Observatory's
// website-research tools (web-fetch.js, page-selection.js). Centralises
// every rule that keeps the fetcher from being usable for SSRF against
// internal infrastructure, and every rule that bounds the size/shape of a
// single research run (MVP-0 limits: homepage + <=8 pages, link depth 1).
//
// Reuses `psl` (Public Suffix List — already a backend dependency) for
// registrable-domain comparison, rather than a naive hostname-suffix check.

const dns = require('node:dns');
const psl = require('psl');

const MAX_URL_LENGTH = 2048;
const MAX_ADDITIONAL_PAGES = 8;
const MAX_PAGES_PER_INVESTIGATION = 1 + MAX_ADDITIONAL_PAGES; // homepage + 8
const MAX_LINK_DEPTH = 1;

const ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);

// Content types this pipeline cannot use (no PDF/image/binary extraction
// tool exists in this task) — rejected at page-selection time, not fetched.
const NON_HTML_EXTENSIONS = Object.freeze([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp',
  '.css', '.js', '.mjs', '.json', '.xml', '.rss',
  '.zip', '.rar', '.7z', '.tar', '.gz',
  '.mp3', '.mp4', '.mov', '.avi', '.wav',
  '.woff', '.woff2', '.ttf', '.eot',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/**
 * Resolves `rawUrl` against `baseUrl`, strips the fragment, lowercases the
 * host, and strips a trailing slash from any non-root path — so that
 * `https://Example.com/About/` and `https://example.com/About` collapse to
 * the same normalised form. Returns null for anything unparseable.
 */
function normaliseUrl(rawUrl, baseUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function dedupeUrls(urls, baseUrl) {
  const seen = new Set();
  const result = [];
  for (const raw of urls) {
    const normalised = normaliseUrl(raw, baseUrl);
    if (!normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    result.push(normalised);
  }
  return result;
}

function exceedsMaxUrlLength(url) {
  return typeof url === 'string' && url.length > MAX_URL_LENGTH;
}

function isAllowedProtocol(url) {
  try {
    return ALLOWED_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function hasRejectedExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return NON_HTML_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/** Registrable ("public suffix + 1") domain for a hostname, via psl. */
function registrableDomain(hostname) {
  if (!hostname) return null;
  const lower = String(hostname).toLowerCase();
  const parsed = psl.parse(lower);
  return (parsed && parsed.domain) ? parsed.domain : lower;
}

function isSameRegistrableDomain(url, rootDomainOrUrl) {
  try {
    const host = new URL(url).hostname;
    let rootHost;
    try {
      rootHost = new URL(rootDomainOrUrl).hostname;
    } catch {
      rootHost = rootDomainOrUrl;
    }
    return registrableDomain(host) === registrableDomain(rootHost);
  } catch {
    return false;
  }
}

// ── SSRF protection: literal-hostname and resolved-IP checks ────────────────

function isLocalHostname(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0';
}

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isIpv4InCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

const PRIVATE_V4_RANGES = Object.freeze([
  ['0.0.0.0', 8],       // "this" network
  ['10.0.0.0', 8],      // RFC1918
  ['100.64.0.0', 10],   // carrier-grade NAT
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local
  ['172.16.0.0', 12],   // RFC1918
  ['192.168.0.0', 16],  // RFC1918
]);

function isPrivateOrReservedIpv4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return PRIVATE_V4_RANGES.some(([base, bits]) => isIpv4InCidr(ip, base, bits));
}

function isPrivateOrReservedIpv6(ip) {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80:') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true; // link-local fe80::/10
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local fc00::/7
  const embedded = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) return isPrivateOrReservedIpv4(embedded[1]);
  return false;
}

function isPrivateOrReservedIp(ip) {
  return ip.includes(':') ? isPrivateOrReservedIpv6(ip) : isPrivateOrReservedIpv4(ip);
}

/**
 * Resolves `hostname` and confirms every returned address is public —
 * guards against DNS rebinding (a public-looking hostname resolving to an
 * internal address). Accepts an injectable `lookup` (defaults to
 * `node:dns`'s callback-style `lookup`) so tests never need real DNS.
 */
function resolveHostnameSafely(hostname, { lookup = dns.lookup } = {}) {
  if (isLocalHostname(hostname)) {
    return Promise.resolve({ safe: false, addresses: [], reason: 'local_hostname' });
  }
  if (isPrivateOrReservedIp(hostname)) {
    return Promise.resolve({ safe: false, addresses: [hostname], reason: 'private_ip_literal' });
  }

  return new Promise((resolve) => {
    lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        resolve({ safe: false, addresses: [], reason: 'dns_resolution_failed' });
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const ips = list.map((a) => (typeof a === 'string' ? a : a.address));
      const unsafe = ips.some(isPrivateOrReservedIp);
      resolve(unsafe
        ? { safe: false, addresses: ips, reason: 'resolves_to_private_address' }
        : { safe: true, addresses: ips, reason: null });
    });
  });
}

module.exports = {
  MAX_URL_LENGTH,
  MAX_ADDITIONAL_PAGES,
  MAX_PAGES_PER_INVESTIGATION,
  MAX_LINK_DEPTH,
  ALLOWED_PROTOCOLS,
  NON_HTML_EXTENSIONS,
  normaliseUrl,
  dedupeUrls,
  exceedsMaxUrlLength,
  isAllowedProtocol,
  hasRejectedExtension,
  registrableDomain,
  isSameRegistrableDomain,
  isLocalHostname,
  isPrivateOrReservedIp,
  isPrivateOrReservedIpv4,
  isPrivateOrReservedIpv6,
  resolveHostnameSafely,
};
