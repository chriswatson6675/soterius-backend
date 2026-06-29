'use strict';
/**
 * Companies House API client — fetches active solicitor firms (SIC 6910).
 *
 * Auth: Basic auth — API key as username, empty password.
 * Docs: https://developer-specs.company-information.service.gov.uk/
 *
 * Required env vars:
 *   COMPANIES_HOUSE_API_KEY or COMPANIES_HOUSE_API  — from https://developer.company-information.service.gov.uk/
 */

const https = require('https');

const CH_API_BASE  = 'https://api.company-information.service.gov.uk';
const SIC_LEGAL    = '6910';
const PAGE_SIZE    = 100; // CH API max
const INTER_PAGE_PAUSE_MS = 300;

// ── Auth ──────────────────────────────────────────────────────────────────────

function apiKey() {
  const k = process.env.COMPANIES_HOUSE_API_KEY || process.env.COMPANIES_HOUSE_API;
  if (!k) throw new Error('COMPANIES_HOUSE_API_KEY (or COMPANIES_HOUSE_API) env var is required');
  return k;
}

function authHeader(key) {
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function chGet(urlStr, key) {
  return new Promise((resolve, reject) => {
    console.log(`[CH] GET ${urlStr}`);
    https.get(urlStr, {
      headers: {
        Authorization: authHeader(key),
        'Accept':      'application/json',
        'User-Agent':  'Soterius-Pipeline/1.0',
      },
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode === 416) {
          // Pagination past end of results — treat as empty page
          resolve({ items: [] });
          return;
        }
        if (res.statusCode === 429) {
          reject(new Error('CH API rate limit — wait before retrying'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`CH API ${res.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`CH JSON parse: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Record normalisation ──────────────────────────────────────────────────────

function normaliseCHRecord(company) {
  // Basic search returns 'title' + 'address'; advanced search returns 'company_name' + 'registered_office_address'
  const name = company.title || company.company_name || '';
  const addr = company.address || company.registered_office_address || {};

  const postcode = addr.postal_code ? addr.postal_code.trim().toUpperCase() : null;
  const town     = addr.locality    ? addr.locality.trim()                   : null;
  const country  = addr.country     ? addr.country.trim()                    : null;

  const locationParts = [town, postcode].filter(Boolean);

  return {
    firm_name:        name,
    website:          null,
    sector:           'solicitors',
    location:         locationParts.join(', ') || null,
    source:           'companies-house',
    source_date:      new Date().toISOString().slice(0, 10),
    source_reference: company.company_number,
    firm_confidence:  95,
    domain_confidence: 0,
    postcode:         postcode,
    notes:            null,
    _regulator:       'SRA',
    _regulator_id:    company.company_number,
    _town:            town,
    _country:         country,
    _search_name:     name,
    _search_location: [town, postcode].filter(Boolean).join(' '),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch up to `limit` active solicitor firms from Companies House.
 *
 * @param {string}  location   Registered office location text (e.g. "Wales", "Bangor")
 * @param {number}  limit      Maximum number of records to return
 * @returns {Promise<object[]>}
 */
// Welsh postcode area prefixes — used for client-side location filtering
const WELSH_POSTCODE_PREFIXES = ['LL', 'CF', 'SA', 'NP', 'SY', 'CH', 'HR', 'LD'];
const WELSH_COUNTRIES = ['wales', 'cymru'];

function matchesLocation(company, location) {
  if (!location) return true;
  const loc = location.toLowerCase();

  const addr    = company.address || company.registered_office_address || {};
  const country = (addr.country  || '').toLowerCase();
  const postcode = (addr.postal_code || '').toUpperCase();
  const snippet  = (company.address_snippet || '').toLowerCase();

  // Match "wales" or "cymru" anywhere in the address snippet or country
  if (loc.includes('wales') || loc.includes('cymru')) {
    if (WELSH_COUNTRIES.some(w => country.includes(w))) return true;
    if (WELSH_COUNTRIES.some(w => snippet.includes(w))) return true;
    if (WELSH_POSTCODE_PREFIXES.some(p => postcode.startsWith(p))) return true;
    return false;
  }

  // For other locations: check address snippet contains the location string
  return snippet.includes(loc);
}

async function fetchSolicitors({ location, limit = 100 } = {}) {
  const key     = apiKey();
  const records = [];
  let startIndex = 0;
  // Fetch more than needed per page to account for location filtering
  const fetchSize = Math.min(PAGE_SIZE, 100);

  while (records.length < limit) {
    const params = new URLSearchParams({
      q:              'solicitors',
      items_per_page: String(fetchSize),
      start_index:    String(startIndex),
    });

    const url  = `${CH_API_BASE}/search/companies?${params}`;
    const data = await chGet(url, key);
    const items = data.items || [];

    if (!items.length) break;

    for (const company of items) {
      if (records.length >= limit) break;
      // Filter: active only
      if (company.company_status !== 'active') continue;
      // Filter: name must contain "solicitor"
      const name = (company.title || company.company_name || '').toLowerCase();
      if (!name.includes('solicitor')) continue;
      // Filter: location match
      if (!matchesLocation(company, location)) continue;
      records.push(normaliseCHRecord(company));
    }

    if (items.length < fetchSize) break;
    startIndex += fetchSize;
    if (records.length < limit) {
      await new Promise(r => setTimeout(r, INTER_PAGE_PAUSE_MS));
    }
  }

  return records;
}

module.exports = { fetchSolicitors };
