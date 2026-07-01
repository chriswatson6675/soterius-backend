'use strict';

// rdap-bootstrap.js — IANA RDAP bootstrap discovery
//
// Fetches the IANA RDAP bootstrap registry (dns.json) and builds a TLD-to-URL
// lookup map for the collection run. Fetched once per run; cached in memory.
//
// Authority: COL-DOMAINREGISTRATION-001 Part 4 — RDAP Acquisition Design
// RFC: RFC 9224 (RDAP bootstrap), RFC 7480 §5.2

const https = require('node:https');

// ── Constants ─────────────────────────────────────────────────────────────────

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TIMEOUT_MS = 15000;

// ── Bootstrap fetch ───────────────────────────────────────────────────────────

/**
 * Fetches the IANA RDAP DNS bootstrap registry and builds the TLD→URL map.
 * Must be called once at run initialisation. Never call mid-run.
 *
 * @returns {Promise<BootstrapCache>}
 * @throws {Error} if fetch fails or response is unparseable
 */
async function loadBootstrap() {
  const raw = await _fetchBootstrapJson();
  const data = JSON.parse(raw);

  if (!Array.isArray(data.services)) {
    throw new Error('RDAP bootstrap response missing services array');
  }

  // Build TLD → RDAP base URL map
  // services format: [ [[tld1, tld2, ...], [url1, ...]], ... ]
  const tldMap = new Map();

  for (const service of data.services) {
    const [tlds, urls] = service;
    if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue;

    const baseUrl = urls[0].endsWith('/') ? urls[0] : urls[0] + '/';

    for (const tld of tlds) {
      tldMap.set(tld.toLowerCase(), baseUrl);
    }
  }

  return {
    tldMap,
    publication: data.publication ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Resolves the RDAP base URL and query URL for a domain.
 * Uses the bootstrap TLD map to find the authoritative registry endpoint.
 *
 * Returns null if no RDAP endpoint is registered for the domain's TLD
 * (signals endpoint_state = RDAP_NOT_SUPPORTED).
 *
 * @param {string} domain - Fully qualified domain name
 * @param {BootstrapCache} cache - Result of loadBootstrap()
 * @returns {{ rdapBaseUrl: string, queryUrl: string } | null}
 */
function resolveRdapEndpoint(domain, cache) {
  const tld = _extractTld(domain, cache.tldMap);
  if (!tld) return null;

  const rdapBaseUrl = cache.tldMap.get(tld);
  if (!rdapBaseUrl) return null;

  // RFC 7482 §3.1.3: domain lookup path is /domain/{fqdn}
  const queryUrl = `${rdapBaseUrl}domain/${domain.toLowerCase()}`;

  return { rdapBaseUrl, queryUrl };
}

// ── TLD extraction ────────────────────────────────────────────────────────────

/**
 * Extracts the effective TLD from a domain by checking multi-part TLDs first.
 * Supports two-part TLDs (co.uk, org.uk, com.au) by checking if the bootstrap
 * map contains the compound suffix before falling back to the single-label TLD.
 *
 * @param {string} domain
 * @param {Map<string, string>} tldMap
 * @returns {string | null} matched TLD string, or null if not found
 */
function _extractTld(domain, tldMap) {
  const lower = domain.toLowerCase().replace(/\.$/, '');
  const parts = lower.split('.');

  if (parts.length < 2) return null;

  // Try two-part TLD first (e.g. "co.uk" from "example.co.uk")
  if (parts.length >= 3) {
    const twoPartTld = parts.slice(-2).join('.');
    if (tldMap.has(twoPartTld)) return twoPartTld;
  }

  // Fall back to single-label TLD
  const singleTld = parts[parts.length - 1];
  if (tldMap.has(singleTld)) return singleTld;

  return null;
}

// ── HTTP fetch helper ─────────────────────────────────────────────────────────

function _fetchBootstrapJson() {
  return new Promise((resolve, reject) => {
    const req = https.get(BOOTSTRAP_URL, { timeout: BOOTSTRAP_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`IANA bootstrap fetch failed: HTTP ${res.statusCode}`));
        res.resume();
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`IANA bootstrap fetch timed out after ${BOOTSTRAP_TIMEOUT_MS}ms`));
    });

    req.on('error', reject);
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { loadBootstrap, resolveRdapEndpoint };

/**
 * @typedef {Object} BootstrapCache
 * @property {Map<string, string>} tldMap - TLD string → RDAP base URL
 * @property {string|null} publication - Bootstrap publication date from IANA
 * @property {string} fetchedAt - ISO timestamp when cache was built
 */
