'use strict';

const dns = require('dns').promises;

const SIGNAL_ID = 'spf';
const SIGNAL_VERSION = 1;

// Maps SPF all-mechanism qualifier to its canonical string representation
const ALL_QUALIFIER_MAP = {
  '+': '+all',
  '-': '-all',
  '~': '~all',
  '?': '?all',
};

const VALID_MECHANISMS = new Set([
  'include', 'a', 'mx', 'ptr', 'ip4', 'ip6', 'exists', 'all', 'redirect', 'exp',
]);

// ── Token parsing ──────────────────────────────────────────────────────────────

function parseToken(token) {
  const qualifierMatch = token.match(/^([+\-~?])(.*)/);
  const qualifier = qualifierMatch ? qualifierMatch[1] : '+';
  const body = qualifierMatch ? qualifierMatch[2] : token;

  const colonIdx = body.indexOf(':');
  const eqIdx = body.indexOf('=');

  if (colonIdx !== -1 && (eqIdx === -1 || colonIdx < eqIdx)) {
    return { qualifier, mechName: body.slice(0, colonIdx).toLowerCase(), mechValue: body.slice(colonIdx + 1) };
  }
  if (eqIdx !== -1) {
    return { qualifier, mechName: body.slice(0, eqIdx).toLowerCase(), mechValue: body.slice(eqIdx + 1) };
  }
  return { qualifier, mechName: body.toLowerCase(), mechValue: null };
}

// ── IPv4 validation ────────────────────────────────────────────────────────────

function checkIp4(mechValue, token, errors) {
  const [addr, cidr] = mechValue.split('/');
  const octets = addr.split('.');
  const validOctets =
    octets.length === 4 &&
    octets.every(o => /^\d{1,3}$/.test(o) && parseInt(o, 10) <= 255);

  if (!validOctets) {
    errors.push({ code: 'INVALID_IP4', message: `Invalid IPv4 address in mechanism: ${token}` });
    return;
  }
  if (cidr !== undefined) {
    const prefix = parseInt(cidr, 10);
    if (!/^\d+$/.test(cidr) || prefix < 0 || prefix > 32) {
      errors.push({ code: 'INVALID_IP4_CIDR', message: `Invalid CIDR prefix length in mechanism: ${token}` });
    }
  }
}

// ── SPF record parser ──────────────────────────────────────────────────────────
//
// Accepts a raw SPF record string and returns observable structural facts.
// Makes no DNS calls — purely string analysis.
//
// Returns:
//   { errors: Array, mechanism: string|null, lookupCount: number, includeCount: number }

function parseSpfRecord(record) {
  const errors = [];
  const tokens = record.trim().split(/\s+/);

  if (!tokens[0] || tokens[0].toLowerCase() !== 'v=spf1') {
    errors.push({ code: 'INVALID_VERSION', message: 'Record does not begin with v=spf1' });
    return { errors, mechanism: null, lookupCount: 0, includeCount: 0 };
  }

  let mechanism = null;
  let lookupCount = 0;
  let includeCount = 0;
  let allCount = 0;
  let allTermIndex = -1;
  let hasValidRedirect = false;
  const terms = tokens.slice(1);

  for (let i = 0; i < terms.length; i++) {
    const token = terms[i];
    const { qualifier, mechName, mechValue } = parseToken(token);

    if (!VALID_MECHANISMS.has(mechName)) {
      errors.push({ code: 'UNKNOWN_MECHANISM', message: `Unknown mechanism or modifier: ${token}` });
      continue;
    }

    switch (mechName) {
      case 'all':
        allCount++;
        allTermIndex = i;
        mechanism = ALL_QUALIFIER_MAP[qualifier] ?? '+all';
        break;

      case 'include':
        if (!mechValue) {
          errors.push({ code: 'MALFORMED_INCLUDE', message: `Malformed include mechanism: ${token}` });
        } else {
          includeCount++;
          lookupCount++;
        }
        break;

      case 'redirect':
        if (!mechValue) {
          errors.push({ code: 'MALFORMED_REDIRECT', message: `Malformed redirect modifier: ${token}` });
        } else {
          hasValidRedirect = true;
          lookupCount++;
        }
        break;

      case 'ip4':
        if (!mechValue) {
          errors.push({ code: 'MALFORMED_IP4', message: `Malformed ip4 mechanism: ${token}` });
        } else {
          checkIp4(mechValue, token, errors);
        }
        break;

      case 'ip6':
        if (!mechValue) {
          errors.push({ code: 'MALFORMED_IP6', message: `Malformed ip6 mechanism: ${token}` });
        }
        break;

      case 'exists':
        if (!mechValue) {
          errors.push({ code: 'MALFORMED_EXISTS', message: `Malformed exists mechanism: ${token}` });
        } else {
          lookupCount++;
        }
        break;

      case 'a':
      case 'mx':
      case 'ptr':
        lookupCount++;
        break;

      case 'exp':
        // explanation modifier — no lookup, no validation required
        break;
    }
  }

  // Post-parse structural checks
  // RFC 7208 §6.1: redirect= substitutes for the evaluated domain entirely,
  // so all mechanism is not required when a valid redirect= is present.
  if (allCount === 0 && !hasValidRedirect) {
    errors.push({ code: 'MISSING_ALL_MECHANISM', message: 'No all mechanism present in SPF record' });
  } else if (allCount > 1) {
    errors.push({ code: 'DUPLICATE_ALL', message: `SPF record contains ${allCount} all mechanisms` });
  } else if (allCount === 1 && allTermIndex !== terms.length - 1) {
    errors.push({ code: 'ALL_NOT_LAST', message: 'all mechanism is not the last term in the SPF record' });
  }

  if (lookupCount > 10) {
    errors.push({
      code: 'LOOKUP_LIMIT_EXCEEDED',
      message: `SPF record requires ${lookupCount} DNS lookups, exceeding the RFC 7208 maximum of 10`,
    });
  }

  return { errors, mechanism, lookupCount, includeCount };
}

// ── DNS error classification ───────────────────────────────────────────────────
//
// Distinguishes between errors that definitively confirm absence of records
// and errors that leave the result genuinely uncertain.
//
// ENODATA — DNS server responded: no TXT records exist for this name.
// ENOTFOUND — Domain does not exist (NXDOMAIN). Both are definitive answers.
// All other errors (ETIMEDOUT, ESERVFAIL, etc.) leave the result unknown.

const DEFINITIVE_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function classifyDnsError(err) {
  const code = err.code ?? '';
  if (DEFINITIVE_ABSENT_CODES.has(code)) return 'ABSENT';
  if (code === 'ETIMEDOUT') return 'DNS_TIMEOUT';
  if (code === 'ESERVFAIL') return 'DNS_SERVFAIL';
  return 'DNS_FAILURE';
}

// ── Result builders ────────────────────────────────────────────────────────────

function absentResult() {
  return {
    spf_present: false,
    spf_collection_error: null,
    spf_record: null,
    spf_record_count: 0,
    spf_parse_success: null,
    spf_syntax_errors: [],
    spf_mechanism: null,
    spf_lookup_count: 0,
    spf_multiple_records: false,
    spf_include_count: 0,
  };
}

function uncertainResult(collectionError) {
  return {
    spf_present: null,
    spf_collection_error: collectionError,
    spf_record: null,
    spf_record_count: null,
    spf_parse_success: null,
    spf_syntax_errors: [],
    spf_mechanism: null,
    spf_lookup_count: null,
    spf_multiple_records: null,
    spf_include_count: null,
  };
}

// ── SPF collector ──────────────────────────────────────────────────────────────
//
// Queries DNS for the apex domain and returns observable SPF facts.
// Accepts an injectable dnsResolver for testing.
//
// spf_present has three states:
//   true  — DNS resolved and an SPF record was found
//   false — DNS resolved and no SPF record exists
//   null  — DNS did not respond reliably; SPF presence is unknown

async function collectSpf(domain, { dnsResolver = dns } = {}) {
  const apex = domain.replace(/^www\./i, '').toLowerCase().trim();

  let allTxtRecords;
  try {
    allTxtRecords = (await dnsResolver.resolveTxt(apex)).map(chunks => chunks.join(''));
  } catch (err) {
    const classification = classifyDnsError(err);
    return classification === 'ABSENT' ? absentResult() : uncertainResult(classification);
  }

  const spfRecords = allTxtRecords.filter(r => r.toLowerCase().startsWith('v=spf1'));
  const spfRecordCount = spfRecords.length;

  if (spfRecordCount === 0) {
    return absentResult();
  }

  const multipleRecords = spfRecordCount > 1;

  // RFC 7208 §3.2: when multiple records exist, use the first and flag the error
  const spfRecord = spfRecords[0];
  const extraErrors = [];

  if (multipleRecords) {
    extraErrors.push({
      code: 'MULTIPLE_SPF_RECORDS',
      message: `${spfRecordCount} SPF records found; RFC 7208 §3.2 requires exactly one`,
    });
  }

  let parseSuccess = false;
  let parsedErrors = [];
  let mechanism = null;
  let lookupCount = 0;
  let includeCount = 0;

  try {
    const result = parseSpfRecord(spfRecord);
    parsedErrors = result.errors;
    mechanism = result.mechanism;
    lookupCount = result.lookupCount;
    includeCount = result.includeCount;
    parseSuccess = true;
  } catch (err) {
    parsedErrors = [{ code: 'PARSE_ERROR', message: err.message }];
  }

  return {
    spf_present: true,
    spf_collection_error: null,
    spf_record: spfRecord,
    spf_record_count: spfRecordCount,
    spf_parse_success: parseSuccess,
    spf_syntax_errors: [...extraErrors, ...parsedErrors],
    spf_mechanism: mechanism,
    spf_lookup_count: lookupCount,
    spf_multiple_records: multipleRecords,
    spf_include_count: includeCount,
  };
}

module.exports = { collectSpf, parseSpfRecord, SIGNAL_ID, SIGNAL_VERSION };
