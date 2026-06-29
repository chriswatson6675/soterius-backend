'use strict';

// SOT-CAA-001 — CAA Signal Collector
//
// Signal Lab principles applied:
//   - Single DNS query: CAA records at the domain apex
//   - Three-state presence: true / false / null
//   - All CAA records preserved verbatim in DNS return order
//   - No inheritance chain traversal; apex only
//   - No interpretation of CA authorization policy
//   - No scores, ratings, or assessments stored
//
// DNS transport:
//   CAA (type 257) is natively supported by Node.js dns.promises.resolveCaa().
//   No DNS over HTTPS required.
//   The dnsResolver parameter is injectable for testing.

const dns = require('node:dns').promises;

const SIGNAL_ID      = 'caa';
const SIGNAL_VERSION = 1;

// ── DNS resolver ───────────────────────────────────────────────────────────────

const defaultDnsResolver = {
  async resolveCaa(name) { return dns.resolveCaa(name); },
};

// ── Error classification ───────────────────────────────────────────────────────
//
// ENODATA   — DNS responded with NODATA; no CAA records for this name.
// ENOTFOUND — Domain does not exist (NXDOMAIN). Both are definitive absence.
// All other codes leave presence genuinely unknown.

const DEFINITIVE_ABSENT_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function classifyDnsError(err) {
  const code = err.code ?? '';
  if (DEFINITIVE_ABSENT_CODES.has(code)) return 'ABSENT';
  if (code === 'ETIMEDOUT')              return 'DNS_TIMEOUT';
  if (code === 'ESERVFAIL')              return 'DNS_SERVFAIL';
  return 'DNS_FAILURE';
}

// ── CAA record parsing ─────────────────────────────────────────────────────────
//
// Parses a Node.js CAA record object into Signal Lab evidence format.
// Node.js dns.resolveCaa() returns: { critical: <flags>, <tag>: <value> }
//
// flags: the raw 8-bit flags field (0–255). Bit 0 (MSB, value 128) is the
//   issuer critical flag per RFC 8659 §4.1. All other bits are reserved.
//   The raw value is preserved without masking.
//
// tag: the property key other than 'critical'. Standard tags: issue,
//   issuewild, iodef. Unknown tags are preserved as-is.
//
// value: the verbatim string for the tag property. An empty string is a
//   valid and significant observation (prohibits issuance for that tag type).
//   Values are not normalised.

function parseCaaRecord(raw) {
  const flags = (typeof raw.critical === 'number') ? raw.critical : 0;

  let tag   = '';
  let value = '';

  for (const key of Object.keys(raw)) {
    if (key !== 'critical' && key !== 'type') {
      tag   = key;
      value = String(raw[key] ?? '');
      break;
    }
  }

  return { flags, tag, value };
}

// ── Result builders ────────────────────────────────────────────────────────────

function absentResult() {
  return {
    dns_caa_present:       false,
    caa_collection_error:  null,
    caa_records:           [],
    caa_record_count:      0,
    caa_issue_count:       0,
    caa_issuewild_count:   0,
    caa_iodef_count:       0,
    caa_unknown_tag_count: 0,
    caa_critical_count:    0,
    caa_issue_values:      [],
    caa_issuewild_values:  [],
    caa_iodef_values:      [],
    caa_tags_present:      [],
  };
}

function uncertainResult(error) {
  return {
    dns_caa_present:       null,
    caa_collection_error:  error,
    caa_records:           [],
    caa_record_count:      null,
    caa_issue_count:       null,
    caa_issuewild_count:   null,
    caa_iodef_count:       null,
    caa_unknown_tag_count: null,
    caa_critical_count:    null,
    caa_issue_values:      [],
    caa_issuewild_values:  [],
    caa_iodef_values:      [],
    caa_tags_present:      [],
  };
}

// ── CAA collector ──────────────────────────────────────────────────────────────
//
// Collects CAA evidence from the domain apex.
//
// dns_caa_present:
//   true  — one or more CAA records found at the apex
//   false — DNS resolved; no CAA records at the apex
//   null  — DNS query failed; presence unknown
//
// Does not follow the CAA inheritance chain. Records only what is published
// at the queried name. Parent zone records are not collected.

async function collectCaa(domain, { dnsResolver = defaultDnsResolver } = {}) {
  const apex = domain.replace(/^www\./i, '').toLowerCase().trim();

  let rawRecords;
  try {
    rawRecords = await dnsResolver.resolveCaa(apex);
  } catch (err) {
    const classification = classifyDnsError(err);
    return classification === 'ABSENT' ? absentResult() : uncertainResult(classification);
  }

  // Some DNS implementations return an empty array for NODATA rather than throwing
  if (!rawRecords || rawRecords.length === 0) {
    return absentResult();
  }

  const records = rawRecords.map(parseCaaRecord);

  let issueCount       = 0;
  let issuewildCount   = 0;
  let iodefCount       = 0;
  let unknownTagCount  = 0;
  let criticalCount    = 0;
  const issueValues     = [];
  const issuewildValues = [];
  const iodefValues     = [];
  const tagSet          = new Set();

  for (const rec of records) {
    const { flags, tag, value } = rec;

    if (flags & 128) criticalCount++;
    if (tag)         tagSet.add(tag);

    switch (tag) {
      case 'issue':
        issueCount++;
        issueValues.push(value);
        break;
      case 'issuewild':
        issuewildCount++;
        issuewildValues.push(value);
        break;
      case 'iodef':
        iodefCount++;
        iodefValues.push(value);
        break;
      default:
        unknownTagCount++;
        break;
    }
  }

  return {
    dns_caa_present:       true,
    caa_collection_error:  null,
    caa_records:           records,
    caa_record_count:      records.length,
    caa_issue_count:       issueCount,
    caa_issuewild_count:   issuewildCount,
    caa_iodef_count:       iodefCount,
    caa_unknown_tag_count: unknownTagCount,
    caa_critical_count:    criticalCount,
    caa_issue_values:      issueValues,
    caa_issuewild_values:  issuewildValues,
    caa_iodef_values:      iodefValues,
    caa_tags_present:      [...tagSet].sort(),
  };
}

module.exports = { collectCaa, parseCaaRecord, SIGNAL_ID, SIGNAL_VERSION };
