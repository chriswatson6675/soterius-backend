'use strict';

// SOT-TLSRPT-001 — TLS Reporting Signal Collector
//
// Signal Lab principles applied:
//   - Three states: present (true) / absent (false) / unknown (null)
//   - dns_tlsrpt_present = false is genuinely observable — _tlsrpt.<domain>
//     has one canonical location; ENODATA/ENOTFOUND definitively confirms absence
//   - All TXT records at _tlsrpt.<domain> preserved in dns_records TEXT[]
//   - Qualifying v=TLSRPTv1 records counted separately in dns_tlsrpt_record_count
//   - Tag values stored as observed; no normalisation applied
//   - First qualifying record is the parsing target; all records kept
//   - rua_raw is the verbatim rua= tag value; rua_uris is the split URI list
//   - URI order is preserved as it appears in the record

const dns = require('node:dns').promises;

const SIGNAL_ID      = 'tls-rpt';
const SIGNAL_VERSION = 1;

// ── DNS error classification ───────────────────────────────────────────────────

const DEFINITIVE_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function classifyDnsError(err) {
  const code = err.code ?? '';
  if (DEFINITIVE_ABSENT_CODES.has(code)) return 'ABSENT';
  if (code === 'ETIMEDOUT')              return 'DNS_TIMEOUT';
  if (code === 'ESERVFAIL')             return 'DNS_SERVFAIL';
  return 'DNS_FAILURE';
}

// ── RUA parser ─────────────────────────────────────────────────────────────────
//
// Accepts the trimmed rua= tag value.
// Splits on commas, preserves URI order, counts by scheme.
// RFC 8460 §3 defines mailto: and https: as the two defined schemes.

function emptyRua() {
  return {
    rua_uris:                 [],
    rua_count:                0,
    rua_mailto_count:         0,
    rua_https_count:          0,
    rua_unknown_scheme_count: 0,
    errors:                   [],
  };
}

function parseRua(rawRua) {
  if (rawRua === null || rawRua === undefined) return emptyRua();

  const trimmed = rawRua.trim();
  if (trimmed === '') {
    return {
      ...emptyRua(),
      errors: [{ code: 'EMPTY_RUA', message: 'rua= tag is present but empty' }],
    };
  }

  const uris    = trimmed.split(',').map(u => u.trim()).filter(u => u);
  const errors  = [];
  let mailtoCount  = 0;
  let httpsCount   = 0;
  let unknownCount = 0;

  for (const uri of uris) {
    const colonIdx = uri.indexOf(':');
    if (colonIdx <= 0) {
      errors.push({ code: 'MALFORMED_URI', message: `URI has no valid scheme: "${uri}"` });
      unknownCount++;
      continue;
    }
    const scheme = uri.slice(0, colonIdx).toLowerCase();
    const rest   = uri.slice(colonIdx + 1);

    if (scheme === 'mailto') {
      mailtoCount++;
      if (!rest.trim()) {
        errors.push({ code: 'MALFORMED_URI', message: `mailto URI has no address: "${uri}"` });
      }
    } else if (scheme === 'https') {
      httpsCount++;
    } else {
      errors.push({ code: 'UNKNOWN_SCHEME', message: `Unrecognised URI scheme "${scheme}": "${uri}"` });
      unknownCount++;
    }
  }

  return {
    rua_uris:                 uris,
    rua_count:                uris.length,
    rua_mailto_count:         mailtoCount,
    rua_https_count:          httpsCount,
    rua_unknown_scheme_count: unknownCount,
    errors,
  };
}

// ── TLS-RPT record parser ──────────────────────────────────────────────────────
//
// Accepts a single raw TLS-RPT TXT record string.
// Returns extracted tag values and any syntax errors found.
// Makes no DNS calls. Pure function.
//
// RFC 8460 §3 tag reference:
//   v   version (required, must be TLSRPTv1, must be first)
//   rua aggregate report URI list (required, comma-separated)
//
// Absent tags → null. RFC defaults never applied.
// Unknown tags preserved verbatim in dns_unknown_tags.

const KNOWN_TAGS = new Set(['v', 'rua']);

function parseTlsRptRecord(rawRecord) {
  if (!rawRecord || rawRecord.trim() === '') {
    return {
      parse_success:            false,
      dns_version:              null,
      dns_unknown_tags:         {},
      rua_raw:                  null,
      rua_uris:                 [],
      rua_count:                0,
      rua_mailto_count:         0,
      rua_https_count:          0,
      rua_unknown_scheme_count: 0,
      syntax_errors:            [{ code: 'EMPTY_RECORD', message: 'TLS-RPT record is empty' }],
    };
  }

  const errors     = [];
  const tags       = {};
  const seenTags   = new Set();
  const unknownTags = {};
  let   firstTagName = null;

  const parts = rawRecord.split(';').map(p => p.trim()).filter(p => p);

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) {
      errors.push({ code: 'MALFORMED_TAG', message: `Tag has no valid key=value form: "${part}"` });
      continue;
    }
    const name  = part.slice(0, eqIdx).trim().toLowerCase();
    const value = part.slice(eqIdx + 1).trim();

    if (!name) {
      errors.push({ code: 'MALFORMED_TAG', message: `Tag has empty key: "${part}"` });
      continue;
    }

    if (firstTagName === null) firstTagName = name;

    if (seenTags.has(name)) {
      errors.push({ code: 'DUPLICATE_TAG', message: `Duplicate tag: ${name}=` });
    } else {
      seenTags.add(name);
      tags[name] = value;
      if (!KNOWN_TAGS.has(name)) {
        unknownTags[name] = value;
      }
    }
  }

  // v= — version (required, must be TLSRPTv1, must be first)
  const version = tags['v'] ?? null;
  if (!seenTags.has('v')) {
    errors.push({ code: 'MISSING_VERSION', message: 'v= tag is absent (required by RFC 8460)' });
  } else if (version !== 'TLSRPTv1') {
    errors.push({ code: 'INVALID_VERSION', message: `Expected v=TLSRPTv1, got v=${version}` });
  } else if (firstTagName !== 'v') {
    errors.push({ code: 'VERSION_NOT_FIRST', message: 'v= tag must be the first tag in the record' });
  }

  // rua= — aggregate report URI list (required)
  const ruaRaw = tags['rua'] ?? null;
  let ruaResult;

  if (!seenTags.has('rua')) {
    errors.push({ code: 'MISSING_RUA', message: 'rua= tag is absent (required by RFC 8460)' });
    ruaResult = emptyRua();
  } else {
    ruaResult = parseRua(ruaRaw);
    errors.push(...ruaResult.errors);
  }

  return {
    parse_success:            errors.length === 0,
    dns_version:              version,
    dns_unknown_tags:         unknownTags,
    rua_raw:                  ruaRaw,
    rua_uris:                 ruaResult.rua_uris,
    rua_count:                ruaResult.rua_count,
    rua_mailto_count:         ruaResult.rua_mailto_count,
    rua_https_count:          ruaResult.rua_https_count,
    rua_unknown_scheme_count: ruaResult.rua_unknown_scheme_count,
    syntax_errors:            errors,
  };
}

// ── Result builders ────────────────────────────────────────────────────────────

function absentResult() {
  return {
    dns_tlsrpt_present:          false,
    dns_collection_error:        null,
    dns_records:                 [],
    dns_record_count:            0,
    dns_tlsrpt_record_count:     0,
    dns_multiple_tlsrpt_records: false,
    dns_parse_success:           null,
    dns_syntax_errors:           [],
    dns_version:                 null,
    dns_unknown_tags:            {},
    rua_raw:                     null,
    rua_uris:                    [],
    rua_count:                   0,
    rua_mailto_count:            0,
    rua_https_count:             0,
    rua_unknown_scheme_count:    0,
  };
}

function uncertainResult(collectionError) {
  return {
    dns_tlsrpt_present:          null,
    dns_collection_error:        collectionError,
    dns_records:                 [],
    dns_record_count:            null,
    dns_tlsrpt_record_count:     null,
    dns_multiple_tlsrpt_records: null,
    dns_parse_success:           null,
    dns_syntax_errors:           [],
    dns_version:                 null,
    dns_unknown_tags:            {},
    rua_raw:                     null,
    rua_uris:                    [],
    rua_count:                   0,
    rua_mailto_count:            0,
    rua_https_count:             0,
    rua_unknown_scheme_count:    0,
  };
}

// ── TLS-RPT collector ──────────────────────────────────────────────────────────
//
// Queries _tlsrpt.<domain> TXT records and returns observable TLS-RPT facts.
// Accepts an injectable dnsResolver for testing.
//
// Evidence preservation:
//   All TXT records at _tlsrpt.<domain> are stored in dns_records[] in
//   DNS return order. No records are discarded.
//   dns_tlsrpt_record_count counts only v=TLSRPTv1 records within that set.
//   Parsing operates on the first qualifying v=TLSRPTv1 record.
//
// dns_tlsrpt_present states:
//   true  — DNS resolved and at least one v=TLSRPTv1 record was found
//   false — DNS resolved and no v=TLSRPTv1 record exists
//   null  — DNS did not respond reliably; presence is unknown

async function collectTlsRpt(domain, { dnsResolver = dns } = {}) {
  const apex  = domain.replace(/^www\./i, '').toLowerCase().trim();
  const qname = `_tlsrpt.${apex}`;

  let allTxtRecords;
  try {
    allTxtRecords = (await dnsResolver.resolveTxt(qname)).map(chunks => chunks.join(''));
  } catch (err) {
    const classification = classifyDnsError(err);
    return classification === 'ABSENT' ? absentResult() : uncertainResult(classification);
  }

  // Filter for v=TLSRPTv1 records — count separately from total TXT records
  const tlsrptRecords = allTxtRecords.filter(r => r.toLowerCase().startsWith('v=tlsrptv1'));
  const tlsrptCount   = tlsrptRecords.length;

  if (tlsrptCount === 0) {
    // DNS returned TXT records, but none qualify as TLS-RPT — definitive absence
    return {
      dns_tlsrpt_present:          false,
      dns_collection_error:        null,
      dns_records:                 allTxtRecords,
      dns_record_count:            allTxtRecords.length,
      dns_tlsrpt_record_count:     0,
      dns_multiple_tlsrpt_records: false,
      dns_parse_success:           null,
      dns_syntax_errors:           [],
      dns_version:                 null,
      dns_unknown_tags:            {},
      rua_raw:                     null,
      rua_uris:                    [],
      rua_count:                   0,
      rua_mailto_count:            0,
      rua_https_count:             0,
      rua_unknown_scheme_count:    0,
    };
  }

  const multipleRecords = tlsrptCount > 1;

  // Collection-level observations prepended to syntax_errors for visibility.
  // parse_success reflects only the first-record parse result.
  const collectionErrors = [];
  if (multipleRecords) {
    collectionErrors.push({
      code:    'MULTIPLE_RECORDS',
      message: `${tlsrptCount} TLS-RPT records found at ${qname}. RFC 8460 §3 requires exactly one. All records preserved.`,
    });
  }

  // Parse the first qualifying record (DNS return order)
  const parsed = parseTlsRptRecord(tlsrptRecords[0]);

  return {
    dns_tlsrpt_present:          true,
    dns_collection_error:        null,
    dns_records:                 allTxtRecords,
    dns_record_count:            allTxtRecords.length,
    dns_tlsrpt_record_count:     tlsrptCount,
    dns_multiple_tlsrpt_records: multipleRecords,
    dns_parse_success:           parsed.parse_success,
    dns_syntax_errors:           [...collectionErrors, ...parsed.syntax_errors],
    dns_version:                 parsed.dns_version,
    dns_unknown_tags:            parsed.dns_unknown_tags,
    rua_raw:                     parsed.rua_raw,
    rua_uris:                    parsed.rua_uris,
    rua_count:                   parsed.rua_count,
    rua_mailto_count:            parsed.rua_mailto_count,
    rua_https_count:             parsed.rua_https_count,
    rua_unknown_scheme_count:    parsed.rua_unknown_scheme_count,
  };
}

module.exports = {
  collectTlsRpt,
  parseTlsRptRecord,
  parseRua,
  SIGNAL_ID,
  SIGNAL_VERSION,
};
