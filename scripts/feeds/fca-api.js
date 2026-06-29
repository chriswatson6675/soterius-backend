'use strict';
/**
 * FCA Register API client.
 *
 * Base URL : https://register.fca.org.uk/services/V0.1
 * Auth     : X-Auth-Email (email) + X-Auth-Key (API key) request headers
 * Rate     : 100 req/min — client enforces 650 ms inter-request delay by default
 *
 * Required env vars:
 *   FCA_EMAIL    — email address registered at register.fca.org.uk/Developer
 *   FCA_API_KEY  — API key from your FCA developer profile
 *
 * Key endpoints used:
 *   GET /CommonSearch?q=<name>&type=firm   — search firms by name
 *   GET /Firm/<FRN>                        — firm details (name, status, business type)
 *   GET /Firm/<FRN>/Address                — address including Website Address field
 *
 * Usage:
 *   const { createClient } = require('./fca-api');
 *   const fca = createClient();
 *   const result = await fca.getFirmWithAddress('153705');
 */

const https = require('https');

const BASE_URL       = 'https://register.fca.org.uk/services/V0.1';
const DEFAULT_DELAY  = 650; // ms between requests — stays safely under 100/min

// ── Credentials ───────────────────────────────────────────────────────────────

function getCredentials() {
  const email  = process.env.FCA_EMAIL;
  const apiKey = process.env.FCA_API_KEY;
  if (!email || !apiKey) {
    throw new Error('FCA_EMAIL and FCA_API_KEY must be set in .env');
  }
  return { email, apiKey };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function get(path, { email, apiKey }) {
  return new Promise((resolve, reject) => {
    const url     = `${BASE_URL}${path}`;
    const options = {
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key':   apiKey,
        'Accept':       'application/json',
        'User-Agent':   'Soterius-Pipeline/1.0',
      },
    };

    https.get(url, options, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(
            `FCA API auth failed (${res.statusCode}). ` +
            'Check FCA_EMAIL and FCA_API_KEY in .env. ' +
            'If credentials are correct, try swapping the header values: ' +
            'some FCA docs show X-Auth-Email containing the key and X-Auth-Key containing the email.'
          ));
          return;
        }
        if (res.statusCode === 404) {
          resolve(null); // FRN not found — caller handles
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('FCA API rate limit exceeded — reduce request frequency or increase RATE_DELAY'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`FCA API ${res.statusCode} for ${path}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`FCA API JSON parse error for ${path}: ${body.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Normalisers ───────────────────────────────────────────────────────────────

function normaliseDomain(raw) {
  if (!raw) return null;
  try {
    const url  = raw.startsWith('http') ? raw : `https://${raw}`;
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

// Extract the best address from an array — prefers one with a website, else first entry
function pickAddress(addresses) {
  if (!addresses || !addresses.length) return {};
  return addresses.find(a => a['Website Address']) || addresses[0];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Search firms by name. Returns the first page of results.
 * @param {string} q     - firm name (partial match)
 * @param {string} type  - 'firm' | 'individual' | 'fund' (default: 'firm')
 */
async function search(q, type = 'firm', creds) {
  const params = new URLSearchParams({ q, type });
  return get(`/CommonSearch?${params}`, creds);
}

/**
 * Fetch firm details by FRN (name, status, business type, effective date).
 */
async function getFirm(frn, creds) {
  return get(`/Firm/${frn}`, creds);
}

/**
 * Fetch firm addresses by FRN. May return multiple entries (registered, principal).
 * Crucially includes Website Address field absent from the bulk CSV.
 */
async function getFirmAddress(frn, creds) {
  return get(`/Firm/${frn}/Address`, creds);
}

/**
 * Fetch firm + address in two requests. Returns a normalised record
 * compatible with the Soterius prospects table schema.
 *
 * @param {string} frn
 * @param {object} creds  - { email, apiKey }
 * @param {number} delay  - ms to wait between the two requests
 */
async function getFirmWithAddress(frn, creds, delay = DEFAULT_DELAY) {
  const firmResp = await getFirm(frn, creds);
  await sleep(delay);
  const addrResp = await getFirmAddress(frn, creds);

  if (!firmResp) return null;

  const firm = (firmResp.Data || [])[0] || {};
  const addr = pickAddress(addrResp ? addrResp.Data : []);

  const rawWebsite = addr['Website Address'] || null;
  const domain     = normaliseDomain(rawWebsite);

  return {
    frn,
    firm_name:       firm['Organisation Name'] || null,
    status:          firm.Status               || null,
    status_date:     firm['Status Effective Date'] || null,
    business_type:   firm['Business Type']     || null,
    companies_house: firm['Companies House Number'] || null,

    // Address fields
    address1:  addr['Address Line 1'] || null,
    address2:  addr['Address Line 2'] || null,
    address3:  addr['Address Line 3'] || null,
    address4:  addr['Address Line 4'] || null,
    town:      addr['Town']           || null,
    county:    addr['County']         || null,
    postcode:  addr['Postcode']       || null,
    country:   addr['Country']        || null,
    phone:     addr['Phone Number']   || null,

    // The field the CSV doesn't have
    website:   domain,
    website_raw: rawWebsite,

    // Soterius import fields
    regulator:        'FCA',
    regulator_id:     frn,
    source:           'fca-api',
    source_reference: `https://register.fca.org.uk/s/firm?id=${frn}`,
    firm_confidence:  95,
    domain_confidence: domain ? 90 : 0,
    active_status:    'active',
  };
}

// ── Client factory ────────────────────────────────────────────────────────────

/**
 * Create an authenticated FCA API client.
 * Reads FCA_EMAIL and FCA_API_KEY from process.env.
 *
 * @returns {{ search, getFirm, getFirmAddress, getFirmWithAddress, sleep, RATE_DELAY }}
 */
function createClient() {
  const creds = getCredentials();
  return {
    search:             (q, type)        => search(q, type, creds),
    getFirm:            (frn)            => getFirm(frn, creds),
    getFirmAddress:     (frn)            => getFirmAddress(frn, creds),
    getFirmWithAddress: (frn, delay)     => getFirmWithAddress(frn, creds, delay),
    sleep,
    RATE_DELAY: DEFAULT_DELAY,
  };
}

module.exports = { createClient };
