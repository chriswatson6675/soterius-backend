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
async function searchCompanies(query, { itemsPerPage = 8 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'COMPANIES_HOUSE_API_KEY is not configured' };

  const url = `${PDA_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=${itemsPerPage}`;
  const res = await chClient.getJson(url, { apiKey });

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
async function getCompanyProfile(companyNumber) {
  const apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'COMPANIES_HOUSE_API_KEY is not configured' };
  if (!companyNumber) return { ok: false, error: 'companyNumber is required', httpStatus: 400 };

  const url = `${PDA_BASE}/company/${encodeURIComponent(normalizeCompanyNumber(companyNumber))}`;
  const res = await chClient.getJson(url, { apiKey });

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

module.exports = { searchCompanies, getCompanyProfile, normalizeCompanyNumber };
