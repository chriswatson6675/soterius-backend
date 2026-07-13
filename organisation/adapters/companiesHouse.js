'use strict';

// companiesHouseLookup.js — live, single-company read access to Companies House.
//
// Reuses the transport-only client at collection/sources/companies-house/ch-client.js
// (the same one the Signal Lab evidence collector uses) but skips the heavyweight
// evidence/provenance collector entirely — this is a synchronous "look one firm up"
// path for the product, not an audited observation pipeline.

const chClient = require('../../collection/sources/companies-house/ch-client');

const PDA_BASE = 'https://api.company-information.service.gov.uk';

function getApiKey() {
  return process.env.COMPANIES_HOUSE_API_KEY || process.env.CH_API_KEY || null;
}

// BUG-2 (found during the Implementation Readiness Sprint, 2026-07-13): this
// module called chClient.getJson() without a rateManager at all, unlike every
// other real caller of ch-client.js (run-if001.js, the companieshouse-collector,
// enrich-registry.js, etc. — see ESD-COMPHOUSE-001 §4.5's combined 600
// requests/5 minutes budget). ch-client's rate limiting and 429 backoff are
// both entirely opt-in via opts.rateManager; omitting it is silent, not an
// error. A full Repository Authority sweep issues a live lookup for every
// Organisation with a known Companies House number (~30,000+ of them) — at
// that volume, unpaced requests exceed the budget within the first few
// hundred calls, and with no rateManager to record the 429 and back off, every
// subsequent call in the same run gets rate-limited too, degrading almost the
// entire rest of a full sweep to `sourcesUnavailable` silently (assemble.js's
// own failure handling treats a CH failure as non-fatal, so this never surfaces
// as a generation failure — only as a mass, silent identity-completeness gap).
// One shared instance for the process lifetime (matches every other real
// caller's pattern: create once, reuse across every request), injectable for
// tests via deps.rateManager.
let sharedRateManager = null;
function defaultRateManager() {
  if (!sharedRateManager) sharedRateManager = chClient.createRateManager();
  return sharedRateManager;
}

// Companies House numbers are canonically 8 characters: either 8 digits
// (England & Wales) or a 2-letter prefix + 6 digits (e.g. OC, SC, NI, LP).
// Upstream sources — the SRA snapshot's CompanyRegNo among them — often carry
// the un-padded numeric form ("3120664" instead of "03120664"), which the
// Companies House API treats as not found. Normalize before every request.
function normalizeCompanyNumber(raw) {
  const trimmed = String(raw || '').trim().toUpperCase();
  if (/^\d+$/.test(trimmed)) return trimmed.padStart(8, '0');
  return trimmed;
}

/**
 * Search companies by free-text name. Returns up to `itemsPerPage` matches.
 * @param {string} query
 * @returns {Promise<{ok: true, results: object[]} | {ok: false, error: string, httpStatus?: number}>}
 */
async function searchCompanies(query, { itemsPerPage = 8 } = {}, deps = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'COMPANIES_HOUSE_API_KEY is not configured' };

  const url = `${PDA_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=${itemsPerPage}`;
  const res = await chClient.getJson(url, { apiKey, rateManager: deps.rateManager || defaultRateManager() });

  if (res.errorType !== 'NONE') {
    return { ok: false, error: `Companies House search failed: ${res.errorType}`, httpStatus: res.httpStatus || 502 };
  }
  const items = Array.isArray(res.body && res.body.items) ? res.body.items : [];
  return { ok: true, results: items.map(normalizeSearchResult) };
}

function normalizeSearchResult(item) {
  return {
    companyNumber: item.company_number,
    name: item.title,
    status: item.company_status,
    type: item.company_type,
    incorporatedOn: item.date_of_creation || null,
    dissolvedOn: item.date_of_cessation || null,
    addressSnippet: item.address_snippet || null,
  };
}

/**
 * Fetch the full company profile by company number (e.g. "OC399969").
 * @param {string} companyNumber
 * @returns {Promise<{ok: true, company: object} | {ok: false, error: string, httpStatus?: number}>}
 */
async function getCompanyProfile(companyNumber, deps = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'COMPANIES_HOUSE_API_KEY is not configured' };
  if (!companyNumber) return { ok: false, error: 'companyNumber is required', httpStatus: 400 };

  const url = `${PDA_BASE}/company/${encodeURIComponent(normalizeCompanyNumber(companyNumber))}`;
  const res = await chClient.getJson(url, { apiKey, rateManager: deps.rateManager || defaultRateManager() });

  if (res.errorType === 'NOT_FOUND') return { ok: false, error: 'Company not found', httpStatus: 404 };
  if (res.errorType !== 'NONE') {
    return { ok: false, error: `Companies House lookup failed: ${res.errorType}`, httpStatus: res.httpStatus || 502 };
  }
  return { ok: true, company: normalizeProfile(res.body) };
}

function normalizeProfile(c) {
  const office = c.registered_office_address || {};
  const accounts = c.accounts || {};
  const lastAccounts = accounts.last_accounts || {};
  return {
    companyNumber: c.company_number,
    name: c.company_name,
    status: c.company_status,
    type: c.type,
    incorporatedOn: c.date_of_creation || null,
    dissolvedOn: c.date_of_cessation || null,
    jurisdiction: c.jurisdiction || null,
    sicCodes: c.sic_codes || [],
    registeredOffice: {
      line1: office.address_line_1 || null,
      line2: office.address_line_2 || null,
      locality: office.locality || null,
      region: office.region || null,
      postalCode: office.postal_code || null,
      country: office.country || null,
    },
    accounts: {
      nextDue: accounts.next_due || null,
      nextMadeUpTo: accounts.next_made_up_to || null,
      lastMadeUpTo: lastAccounts.made_up_to || null,
      accountingReferenceDate: accounts.accounting_reference_date || null,
    },
    source: 'Companies House (live)',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = {
  searchCompanies, getCompanyProfile, normalizeCompanyNumber,
  // Test-only seam: reset the shared rate manager singleton between tests so
  // one test's simulated 429/suspension state can't leak into another's.
  _resetRateManagerForTests: () => { sharedRateManager = null; },
};
