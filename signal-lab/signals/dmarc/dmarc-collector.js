'use strict';

// SOT-DMARC-001 — DMARC Signal Collector
//
// Signal Lab principles applied:
//   - Three states: present (true) / absent (false) / unknown (null)
//   - dmarc_present = false is genuinely observable — _dmarc.<domain> has one
//     canonical location; ENODATA/ENOTFOUND definitively confirms absence
//   - All v=DMARC1 records preserved in dmarc_records TEXT[]
//   - Tag values stored as observed; RFC defaults never applied
//   - dmarc_records[0] (first record) is the parsing target; all records kept

const dns = require('node:dns').promises;

const SIGNAL_ID      = 'dmarc';
const SIGNAL_VERSION = 1;

// ── DNS error classification ───────────────────────────────────────────────────

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
    dmarc_present:          false,
    dmarc_collection_error: null,
    dmarc_records:          [],
    dmarc_record_count:     0,
    dmarc_multiple_records: false,
    dmarc_parse_success:    null,
    dmarc_syntax_errors:    [],
    dmarc_version:          null,
    dmarc_policy:           null,
    dmarc_subdomain_policy: null,
    dmarc_adkim:            null,
    dmarc_aspf:             null,
    dmarc_pct:              null,
    dmarc_rua:              null,
    dmarc_ruf:              null,
    dmarc_rua_count:        0,
    dmarc_ruf_count:        0,
    dmarc_fo:               null,
    dmarc_ri:               null,
    dmarc_rf:               null,
  };
}

function uncertainResult(collectionError) {
  return {
    dmarc_present:          null,
    dmarc_collection_error: collectionError,
    dmarc_records:          [],
    dmarc_record_count:     null,
    dmarc_multiple_records: null,
    dmarc_parse_success:    null,
    dmarc_syntax_errors:    [],
    dmarc_version:          null,
    dmarc_policy:           null,
    dmarc_subdomain_policy: null,
    dmarc_adkim:            null,
    dmarc_aspf:             null,
    dmarc_pct:              null,
    dmarc_rua:              null,
    dmarc_ruf:              null,
    dmarc_rua_count:        0,
    dmarc_ruf_count:        0,
    dmarc_fo:               null,
    dmarc_ri:               null,
    dmarc_rf:               null,
  };
}

// ── DMARC record parser ────────────────────────────────────────────────────────
//
// Accepts a single raw DMARC TXT record string.
// Returns extracted tag values and any syntax errors found.
// Makes no DNS calls. Pure function.
//
// RFC 7489 tag reference:
//   v    version (required, must be DMARC1, must be first)
//   p    domain policy (required: none / quarantine / reject)
//   sp   subdomain policy (optional: none / quarantine / reject)
//   rua  aggregate report URIs (optional, comma-separated mailto: list)
//   ruf  forensic report URIs  (optional, comma-separated mailto: list)
//   fo   failure reporting options (optional, colon-separated: 0/1/d/s)
//   pct  percentage of messages filtered (optional, integer 0-100)
//   adkim DKIM alignment mode (optional: r=relaxed / s=strict)
//   aspf  SPF alignment mode  (optional: r=relaxed / s=strict)
//   rf   failure report format (optional, colon-separated)
//   ri   reporting interval in seconds (optional, integer)
//
// Absent tags are stored as null. RFC defaults are NEVER applied.

const VALID_POLICIES = new Set(['none', 'quarantine', 'reject']);
const VALID_ALIGNMENT = new Set(['r', 's']);

function parseDmarcRecord(rawRecord) {
  if (!rawRecord || rawRecord.trim() === '') {
    return {
      parse_success:      false,
      dmarc_version:      null,
      dmarc_policy:       null,
      dmarc_subdomain_policy: null,
      dmarc_adkim:        null,
      dmarc_aspf:         null,
      dmarc_pct:          null,
      dmarc_rua:          null,
      dmarc_ruf:          null,
      dmarc_rua_count:    0,
      dmarc_ruf_count:    0,
      dmarc_fo:           null,
      dmarc_ri:           null,
      dmarc_rf:           null,
      syntax_errors:      [{ code: 'EMPTY_RECORD', message: 'DMARC record is empty' }],
    };
  }

  const errors   = [];
  const tags     = {};
  const seenTags = new Set();

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
    } else {
      seenTags.add(name);
      tags[name] = value;
    }
  }

  // v= — version (required, must be first)
  const version = tags['v'] ?? null;
  if (!seenTags.has('v')) {
    errors.push({ code: 'MISSING_VERSION', message: 'v= tag is absent (required by RFC 7489)' });
  } else if (version !== 'DMARC1') {
    errors.push({ code: 'INVALID_VERSION', message: `Expected v=DMARC1, got v=${version}` });
  } else {
    const firstTagName = parts[0]?.split('=')[0]?.trim()?.toLowerCase();
    if (firstTagName !== 'v') {
      errors.push({ code: 'VERSION_NOT_FIRST', message: 'v= tag must be the first tag in the record' });
    }
  }

  // p= — policy (required)
  const policyRaw = tags['p'] ?? null;
  let   policy    = null;
  if (!seenTags.has('p')) {
    errors.push({ code: 'MISSING_POLICY', message: 'p= tag is absent (required by RFC 7489)' });
  } else if (!VALID_POLICIES.has((policyRaw ?? '').toLowerCase())) {
    errors.push({ code: 'INVALID_POLICY', message: `Invalid p= value: "${policyRaw}". Must be none, quarantine, or reject` });
  } else {
    policy = policyRaw.toLowerCase();
  }

  // sp= — subdomain policy (optional)
  const spRaw = tags['sp'] ?? null;
  let   subdomainPolicy = null;
  if (spRaw !== null) {
    if (!VALID_POLICIES.has(spRaw.toLowerCase())) {
      errors.push({ code: 'INVALID_SUBDOMAIN_POLICY', message: `Invalid sp= value: "${spRaw}". Must be none, quarantine, or reject` });
    } else {
      subdomainPolicy = spRaw.toLowerCase();
    }
  }

  // adkim= — DKIM alignment (optional)
  const adkimRaw = tags['adkim'] ?? null;
  let   adkim    = null;
  if (adkimRaw !== null) {
    if (!VALID_ALIGNMENT.has(adkimRaw.toLowerCase())) {
      errors.push({ code: 'INVALID_ADKIM', message: `Invalid adkim= value: "${adkimRaw}". Must be r or s` });
    } else {
      adkim = adkimRaw.toLowerCase();
    }
  }

  // aspf= — SPF alignment (optional)
  const aspfRaw = tags['aspf'] ?? null;
  let   aspf    = null;
  if (aspfRaw !== null) {
    if (!VALID_ALIGNMENT.has(aspfRaw.toLowerCase())) {
      errors.push({ code: 'INVALID_ASPF', message: `Invalid aspf= value: "${aspfRaw}". Must be r or s` });
    } else {
      aspf = aspfRaw.toLowerCase();
    }
  }

  // pct= — percentage (optional, integer 0-100)
  const pctRaw = tags['pct'];
  let   pct    = null;
  if (pctRaw !== undefined) {
    const pctInt = parseInt(pctRaw, 10);
    if (!/^\d+$/.test(pctRaw) || pctInt < 0 || pctInt > 100) {
      errors.push({ code: 'INVALID_PCT', message: `Invalid pct= value: "${pctRaw}". Must be an integer 0–100` });
    } else {
      pct = pctInt;
    }
  }

  // rua= — aggregate report URIs (optional, raw string preserved)
  const rua    = tags['rua'] ?? null;
  const ruaCount = rua
    ? rua.split(',').map(u => u.trim()).filter(u => u).length
    : 0;

  // ruf= — forensic report URIs (optional, raw string preserved)
  const ruf    = tags['ruf'] ?? null;
  const rufCount = ruf
    ? ruf.split(',').map(u => u.trim()).filter(u => u).length
    : 0;

  // fo= — failure reporting options (optional, raw string preserved)
  const fo = tags['fo'] ?? null;

  // ri= — reporting interval in seconds (optional, integer)
  const riRaw = tags['ri'];
  let   ri    = null;
  if (riRaw !== undefined) {
    const riInt = parseInt(riRaw, 10);
    if (!/^\d+$/.test(riRaw) || riInt < 0) {
      errors.push({ code: 'INVALID_RI', message: `Invalid ri= value: "${riRaw}". Must be a non-negative integer` });
    } else {
      ri = riInt;
    }
  }

  // rf= — reporting format (optional, raw string preserved)
  const rf = tags['rf'] ?? null;

  return {
    parse_success:      errors.length === 0,
    dmarc_version:      version,
    dmarc_policy:       policy,
    dmarc_subdomain_policy: subdomainPolicy,
    dmarc_adkim:        adkim,
    dmarc_aspf:         aspf,
    dmarc_pct:          pct,
    dmarc_rua:          rua,
    dmarc_ruf:          ruf,
    dmarc_rua_count:    ruaCount,
    dmarc_ruf_count:    rufCount,
    dmarc_fo:           fo,
    dmarc_ri:           ri,
    dmarc_rf:           rf,
    syntax_errors:      errors,
  };
}

// ── DMARC collector ────────────────────────────────────────────────────────────
//
// Queries _dmarc.<domain> TXT records and returns observable DMARC facts.
// Accepts an injectable dnsResolver for testing.
//
// Evidence preservation:
//   All v=DMARC1 records are stored in dmarc_records[] in DNS return order.
//   No records are discarded. Parsing operates on dmarc_records[0].
//
// dmarc_present states:
//   true  — DNS resolved and at least one v=DMARC1 record was found
//   false — DNS resolved and no v=DMARC1 record exists (genuine observable absence)
//   null  — DNS did not respond reliably; presence is unknown

async function collectDmarc(domain, { dnsResolver = dns } = {}) {
  const apex  = domain.replace(/^www\./i, '').toLowerCase().trim();
  const qname = `_dmarc.${apex}`;

  let allTxtRecords;
  try {
    allTxtRecords = (await dnsResolver.resolveTxt(qname)).map(chunks => chunks.join(''));
  } catch (err) {
    const classification = classifyDnsError(err);
    return classification === 'ABSENT' ? absentResult() : uncertainResult(classification);
  }

  // Filter for v=DMARC1 records — preserve all of them
  const dmarcRecords = allTxtRecords.filter(r => r.toLowerCase().startsWith('v=dmarc1'));

  if (dmarcRecords.length === 0) {
    return absentResult();
  }

  const multipleRecords = dmarcRecords.length > 1;

  // Parse the first record (index 0)
  const parsed = parseDmarcRecord(dmarcRecords[0]);

  // MULTIPLE_RECORDS is a collection-level observation, prepended to syntax_errors
  // for visibility. parse_success reflects only the first-record parse result.
  const collectionErrors = [];
  if (multipleRecords) {
    collectionErrors.push({
      code:    'MULTIPLE_RECORDS',
      message: `${dmarcRecords.length} DMARC records found at ${qname}. RFC 7489 §6.6.3 requires exactly one. All records preserved.`,
    });
  }

  return {
    dmarc_present:          true,
    dmarc_collection_error: null,
    dmarc_records:          dmarcRecords,
    dmarc_record_count:     dmarcRecords.length,
    dmarc_multiple_records: multipleRecords,
    dmarc_parse_success:    parsed.parse_success,
    dmarc_syntax_errors:    [...collectionErrors, ...parsed.syntax_errors],
    dmarc_version:          parsed.dmarc_version,
    dmarc_policy:           parsed.dmarc_policy,
    dmarc_subdomain_policy: parsed.dmarc_subdomain_policy,
    dmarc_adkim:            parsed.dmarc_adkim,
    dmarc_aspf:             parsed.dmarc_aspf,
    dmarc_pct:              parsed.dmarc_pct,
    dmarc_rua:              parsed.dmarc_rua,
    dmarc_ruf:              parsed.dmarc_ruf,
    dmarc_rua_count:        parsed.dmarc_rua_count,
    dmarc_ruf_count:        parsed.dmarc_ruf_count,
    dmarc_fo:               parsed.dmarc_fo,
    dmarc_ri:               parsed.dmarc_ri,
    dmarc_rf:               parsed.dmarc_rf,
  };
}

module.exports = { collectDmarc, parseDmarcRecord, SIGNAL_ID, SIGNAL_VERSION };
