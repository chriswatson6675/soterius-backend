'use strict';

// SOT-MTASTS-001 — MTA-STS Signal Collector
//
// Signal Lab principles applied:
//   - Two independent observation layers: DNS and HTTPS
//   - DNS three-state: present (true) / absent (false) / unknown (null)
//   - HTTPS three-state: present (true) / absent (false) / unknown (null)
//   - Two-pass TLS retrieval — Pass 1 validated; Pass 2 non-validating (Category A errors only)
//   - Pass 1 TLS observations (policy_tls_valid, policy_tls_error) are never overwritten by Pass 2
//   - All v=STSv1 records preserved in dns_records TEXT[]
//   - Raw policy body preserved verbatim in policy_body_raw
//   - Absent tags/fields stored as null; RFC defaults never applied
//   - Unknown DNS tags and unknown policy fields preserved as evidence

const dns   = require('node:dns').promises;
const https = require('node:https');
const axios = require('axios');

const SIGNAL_ID      = 'mta-sts';
const SIGNAL_VERSION = 1;

// ── DNS error classification ────────────────────────────────────────────────────

const DEFINITIVE_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function classifyDnsError(err) {
  const code = err.code ?? '';
  if (DEFINITIVE_ABSENT_CODES.has(code)) return 'ABSENT';
  if (code === 'ETIMEDOUT') return 'DNS_TIMEOUT';
  if (code === 'ESERVFAIL') return 'DNS_SERVFAIL';
  return 'DNS_FAILURE';
}

// ── Fetch error classification ──────────────────────────────────────────────────
//
// Returns one of three kinds:
//   tls_category_a — certificate validation failure; TLS session was established;
//                    Pass 2 (non-validating) can retrieve the policy body
//   tls_category_b — TLS handshake failure; no session established; no Pass 2 possible
//   fetch_error    — network-layer failure before or independent of TLS

function classifyFetchError(err) {
  const code = err.code ?? '';

  switch (code) {
    // Category A: certificate validation failures
    case 'CERT_HAS_EXPIRED':
      return { kind: 'tls_category_a', tlsError: 'CERT_EXPIRED' };
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { kind: 'tls_category_a', tlsError: 'CERT_HOSTNAME_MISMATCH' };
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return { kind: 'tls_category_a', tlsError: 'CERT_SELF_SIGNED' };
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'CERT_UNTRUSTED':
      return { kind: 'tls_category_a', tlsError: 'CERT_UNTRUSTED' };

    // Category B: handshake failure — no session established
    case 'EPROTO':
      return { kind: 'tls_category_b', tlsError: 'TLS_HANDSHAKE_FAILURE' };

    // Network errors
    case 'ECONNREFUSED':
      return { kind: 'fetch_error', fetchError: 'CONNECTION_REFUSED' };
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { kind: 'fetch_error', fetchError: 'DNS_ERROR' };

    default:
      if (code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_')) {
        return { kind: 'tls_category_b', tlsError: 'TLS_HANDSHAKE_FAILURE' };
      }
      return { kind: 'fetch_error', fetchError: 'CONNECTION_TIMEOUT' };
  }
}

// ── DNS record parser ───────────────────────────────────────────────────────────
//
// Parses a single _mta-sts.<domain> TXT record string.
// RFC 8461 defines exactly two tags: v= (version) and id= (policy identifier).
// Any other tag=value pairs are preserved verbatim in dns_unknown_tags.

function parseStsRecord(rawRecord) {
  if (!rawRecord || rawRecord.trim() === '') {
    return {
      parse_success:    false,
      dns_version:      null,
      dns_id:           null,
      dns_unknown_tags: {},
      syntax_errors:    [{ code: 'EMPTY_RECORD', message: 'DNS record is empty' }],
    };
  }

  const errors      = [];
  const seenTags    = new Set();
  const knownTags   = {};
  const unknownTags = {};

  const parts = rawRecord.split(';').map(p => p.trim()).filter(p => p);

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) {
      errors.push({ code: 'MALFORMED_TAG', message: `Tag has no = sign: ${part}` });
      continue;
    }
    const name  = part.slice(0, eqIdx).trim().toLowerCase();
    const value = part.slice(eqIdx + 1).trim();

    if (seenTags.has(name)) {
      errors.push({ code: 'DUPLICATE_TAG', message: `Duplicate tag: ${name}=` });
      continue;
    }
    seenTags.add(name);

    if (name === 'v' || name === 'id') {
      knownTags[name] = value;
    } else {
      unknownTags[name] = value;
    }
  }

  // v= — version (required, must be STSv1)
  const version = knownTags['v'] ?? null;
  if (!seenTags.has('v')) {
    errors.push({ code: 'MISSING_VERSION', message: 'v= tag is absent (required by RFC 8461)' });
  } else if (version !== 'STSv1') {
    errors.push({ code: 'INVALID_VERSION', message: `Expected v=STSv1, got v=${version}` });
  }

  // id= — policy identifier (required)
  const id = knownTags['id'] ?? null;
  if (!seenTags.has('id')) {
    errors.push({ code: 'MISSING_ID', message: 'id= tag is absent (required by RFC 8461)' });
  }

  return {
    parse_success:    errors.length === 0,
    dns_version:      version,
    dns_id:           id,
    dns_unknown_tags: unknownTags,
    syntax_errors:    errors,
  };
}

// ── Policy file parser ──────────────────────────────────────────────────────────
//
// Parses the body of https://mta-sts.<domain>/.well-known/mta-sts.txt.
// RFC 8461 §3.2 defines four fields: version, mode, mx (repeatable), max_age.
// Unknown fields are preserved verbatim in policy_unknown_fields.
// Absent fields are stored as null; RFC defaults are never applied.

const VALID_MODES = new Set(['enforce', 'testing', 'none']);

function parsePolicyBody(body) {
  if (!body || body.trim() === '') {
    return {
      parse_success:        false,
      policy_version:       null,
      policy_mode:          null,
      policy_max_age:       null,
      policy_mx_patterns:   [],
      policy_mx_count:      0,
      policy_unknown_fields: {},
      syntax_errors:        [{ code: 'EMPTY_BODY', message: 'Policy file body is empty' }],
    };
  }

  const errors        = [];
  const seenKeys      = new Set();
  let   policyVersion = null;
  let   policyMode    = null;
  let   policyMaxAge  = null;
  const mxPatterns    = [];
  const unknownFields = {};

  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      errors.push({ code: 'MALFORMED_LINE', message: `Line has no colon separator: ${line.slice(0, 80)}` });
      continue;
    }

    const key   = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    switch (key) {
      case 'version':
        if (seenKeys.has('version')) {
          errors.push({ code: 'DUPLICATE_FIELD', message: 'version field appears more than once' });
        } else {
          seenKeys.add('version');
          policyVersion = value;
          if (value !== 'STSv1') {
            errors.push({ code: 'INVALID_VERSION', message: `Expected version: STSv1, got: ${value}` });
          }
        }
        break;

      case 'mode':
        if (seenKeys.has('mode')) {
          errors.push({ code: 'DUPLICATE_FIELD', message: 'mode field appears more than once' });
        } else {
          seenKeys.add('mode');
          const modeLower = value.toLowerCase();
          if (!VALID_MODES.has(modeLower)) {
            errors.push({ code: 'INVALID_MODE', message: `Invalid mode: "${value}". Must be enforce, testing, or none` });
            policyMode = null;
          } else {
            policyMode = modeLower;
          }
        }
        break;

      case 'max_age':
        if (seenKeys.has('max_age')) {
          errors.push({ code: 'DUPLICATE_FIELD', message: 'max_age field appears more than once' });
        } else {
          seenKeys.add('max_age');
          if (!/^\d+$/.test(value)) {
            errors.push({ code: 'INVALID_MAX_AGE', message: `Invalid max_age: "${value}". Must be a non-negative integer` });
          } else {
            policyMaxAge = parseInt(value, 10);
          }
        }
        break;

      case 'mx':
        // mx is the only repeatable field; each entry preserved in order
        mxPatterns.push(value);
        break;

      default:
        // Unknown field — preserve as evidence; last value wins on duplicate
        if (unknownFields[key] !== undefined) {
          errors.push({ code: 'DUPLICATE_UNKNOWN_FIELD', message: `Unknown field "${key}" appears more than once; last value used` });
        }
        unknownFields[key] = value;
        break;
    }
  }

  // Missing required fields
  if (!seenKeys.has('version')) {
    errors.push({ code: 'MISSING_VERSION', message: 'version field is required by RFC 8461' });
  }
  if (!seenKeys.has('mode')) {
    errors.push({ code: 'MISSING_MODE', message: 'mode field is required by RFC 8461' });
  }
  if (!seenKeys.has('max_age')) {
    errors.push({ code: 'MISSING_MAX_AGE', message: 'max_age field is required by RFC 8461' });
  }

  return {
    parse_success:         errors.length === 0,
    policy_version:        policyVersion,
    policy_mode:           policyMode,
    policy_max_age:        policyMaxAge,
    policy_mx_patterns:    mxPatterns,
    policy_mx_count:       mxPatterns.length,
    policy_unknown_fields: unknownFields,
    syntax_errors:         errors,
  };
}

// ── Default HTTP fetcher ────────────────────────────────────────────────────────
//
// Real implementation using axios.
// options.rejectUnauthorized = false disables certificate validation (Pass 2).
// Returns { httpStatus, body, contentType, redirectCount }.
// Throws with native Node.js error codes on failure — caller classifies via classifyFetchError.

async function defaultHttpFetcher(url, { rejectUnauthorized = true } = {}) {
  const httpsAgent = new https.Agent({ rejectUnauthorized });

  const response = await axios.get(url, {
    httpsAgent,
    maxRedirects:     10,
    validateStatus:   () => true,   // never throw for 4xx/5xx; caller handles status
    timeout:          10000,
    responseType:     'text',
    maxContentLength: 100 * 1024,   // 100 KB cap — policy files are tiny
  });

  // follow-redirects (used internally by axios) exposes _redirectCount on the request
  const redirectCount = response.request?._redirectable?._redirectCount ?? 0;

  return {
    httpStatus:   response.status,
    body:         typeof response.data === 'string' ? response.data : null,
    contentType:  response.headers?.['content-type'] ?? null,
    redirectCount,
  };
}

// ── DNS result builders ─────────────────────────────────────────────────────────

function dnsAbsentResult() {
  return {
    dns_sts_present:          false,
    dns_collection_error:     null,
    dns_records:              [],
    dns_record_count:         0,
    dns_sts_record_count:     0,
    dns_multiple_sts_records: false,
    dns_parse_success:        null,
    dns_syntax_errors:        [],
    dns_version:              null,
    dns_id:                   null,
    dns_unknown_tags:         {},
  };
}

function dnsUncertainResult(collectionError) {
  return {
    dns_sts_present:          null,
    dns_collection_error:     collectionError,
    dns_records:              [],
    dns_record_count:         null,
    dns_sts_record_count:     null,
    dns_multiple_sts_records: null,
    dns_parse_success:        null,
    dns_syntax_errors:        [],
    dns_version:              null,
    dns_id:                   null,
    dns_unknown_tags:         {},
  };
}

// ── Policy observation initial state ───────────────────────────────────────────

function policyBaseObs(attempted) {
  return {
    policy_fetch_attempted:    attempted,
    policy_present:            null,
    policy_fetch_error:        null,
    policy_http_status:        null,
    policy_tls_valid:          null,
    policy_tls_error:          null,
    policy_redirect_count:     0,
    policy_content_type:       null,
    policy_body_raw:           null,
    policy_body_tls_validated: null,
    policy_parse_success:      null,
    policy_syntax_errors:      [],
    policy_version:            null,
    policy_mode:               null,
    policy_max_age:            null,
    policy_mx_patterns:        [],
    policy_mx_count:           0,
    policy_unknown_fields:     {},
  };
}

// ── Apply parsed policy fields onto obs object (mutates) ───────────────────────

function applyParsedPolicy(obs, parsed) {
  obs.policy_parse_success   = parsed.parse_success;
  obs.policy_syntax_errors   = parsed.syntax_errors;
  obs.policy_version         = parsed.policy_version;
  obs.policy_mode            = parsed.policy_mode;
  obs.policy_max_age         = parsed.policy_max_age;
  obs.policy_mx_patterns     = parsed.policy_mx_patterns;
  obs.policy_mx_count        = parsed.policy_mx_count;
  obs.policy_unknown_fields  = parsed.policy_unknown_fields;
}

// ── Apply HTTP response fields onto obs object (mutates) ───────────────────────

function applyHttpResponse(obs, result, tlsValidated) {
  obs.policy_http_status        = result.httpStatus;
  obs.policy_redirect_count     = result.redirectCount;
  obs.policy_content_type       = result.contentType;
  obs.policy_body_raw           = result.body;
  obs.policy_body_tls_validated = tlsValidated;
  obs.policy_present            = result.httpStatus >= 200 && result.httpStatus < 300 ? true : false;
}

// ── DNS collection ──────────────────────────────────────────────────────────────

async function collectDns(apex, dnsResolver) {
  const qname = `_mta-sts.${apex}`;

  let allTxtRecords;
  try {
    allTxtRecords = (await dnsResolver.resolveTxt(qname)).map(chunks => chunks.join(''));
  } catch (err) {
    const classification = classifyDnsError(err);
    return classification === 'ABSENT' ? dnsAbsentResult() : dnsUncertainResult(classification);
  }

  const stsRecords = allTxtRecords.filter(r => r.toLowerCase().startsWith('v=stsv1'));

  if (stsRecords.length === 0) {
    return dnsAbsentResult();
  }

  const multipleRecords    = stsRecords.length > 1;
  const collectionErrors   = [];

  if (multipleRecords) {
    collectionErrors.push({
      code:    'MULTIPLE_RECORDS',
      message: `${stsRecords.length} v=STSv1 records found at ${qname}. RFC 8461 requires exactly one. All records preserved.`,
    });
  }

  const parsed = parseStsRecord(stsRecords[0]);

  return {
    dns_sts_present:          true,
    dns_collection_error:     null,
    dns_records:              stsRecords,
    dns_record_count:         stsRecords.length,
    dns_sts_record_count:     stsRecords.length,
    dns_multiple_sts_records: multipleRecords,
    dns_parse_success:        parsed.parse_success,
    dns_syntax_errors:        [...collectionErrors, ...parsed.syntax_errors],
    dns_version:              parsed.dns_version,
    dns_id:                   parsed.dns_id,
    dns_unknown_tags:         parsed.dns_unknown_tags,
  };
}

// ── HTTPS collection ────────────────────────────────────────────────────────────
//
// Two-pass TLS retrieval:
//   Pass 1 — validated connection. Records policy_tls_valid and policy_tls_error.
//             On success: body collected with policy_body_tls_validated = true. Done.
//             On Category A error: record TLS obs; proceed to Pass 2.
//             On Category B error: record TLS obs; stop. No body collectable.
//             On network error: record fetch error; stop.
//
//   Pass 2 — non-validating connection. Only reached after Category A TLS failure.
//             Pass 1 TLS observations are NEVER overwritten by Pass 2.
//             Body collected with policy_body_tls_validated = false.
//             If Pass 2 also fails: record fetch error; policy_present = null.

async function collectHttps(apex, httpFetcher) {
  const url = `https://mta-sts.${apex}/.well-known/mta-sts.txt`;
  const obs = policyBaseObs(true);

  // ── Pass 1: validated TLS ──────────────────────────────────────────────────

  let needsPass2 = false;

  try {
    const result = await httpFetcher(url, { rejectUnauthorized: true });
    obs.policy_tls_valid = true;
    applyHttpResponse(obs, result, true);
    if (obs.policy_present === true && result.body) {
      applyParsedPolicy(obs, parsePolicyBody(result.body));
    }
    return obs;
  } catch (err) {
    const classified = classifyFetchError(err);

    if (classified.kind === 'tls_category_a') {
      obs.policy_tls_valid = false;
      obs.policy_tls_error = classified.tlsError;
      needsPass2 = true;
    } else if (classified.kind === 'tls_category_b') {
      obs.policy_tls_valid = false;
      obs.policy_tls_error = classified.tlsError;
      // policy_present remains null — we could not determine presence
      return obs;
    } else {
      // fetch_error: network failure; TLS layer not reached
      obs.policy_fetch_error = classified.fetchError;
      // policy_tls_valid remains null — TLS was never established
      return obs;
    }
  }

  if (!needsPass2) return obs;

  // ── Pass 2: non-validating connection ─────────────────────────────────────
  // policy_tls_valid and policy_tls_error are fixed from Pass 1. Must not change.

  try {
    const result = await httpFetcher(url, { rejectUnauthorized: false });
    applyHttpResponse(obs, result, false);
    if (obs.policy_present === true && result.body) {
      applyParsedPolicy(obs, parsePolicyBody(result.body));
    }
  } catch (err) {
    const classified = classifyFetchError(err);
    // Record the Pass 2 network failure. TLS observations from Pass 1 remain unchanged.
    obs.policy_fetch_error = classified.fetchError ?? 'CONNECTION_TIMEOUT';
    // policy_present remains null
  }

  return obs;
}

// ── Main collector ──────────────────────────────────────────────────────────────
//
// Collects MTA-STS DNS and HTTPS observations independently.
// Both are always attempted; neither depends on the other's result.
//
// Injectable:
//   dnsResolver  — replaces node:dns.promises for testing
//   httpFetcher  — replaces defaultHttpFetcher for testing

async function collectMtaSts(domain, { dnsResolver = dns, httpFetcher = defaultHttpFetcher } = {}) {
  const apex = domain.replace(/^www\./i, '').toLowerCase().trim();

  const [dnsResult, httpsResult] = await Promise.all([
    collectDns(apex, dnsResolver),
    collectHttps(apex, httpFetcher),
  ]);

  return { ...dnsResult, ...httpsResult };
}

module.exports = {
  collectMtaSts,
  parseStsRecord,
  parsePolicyBody,
  classifyFetchError,
  SIGNAL_ID,
  SIGNAL_VERSION,
};
