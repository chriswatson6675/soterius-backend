'use strict';

// SOT-TLSRPT-001 — TLS-RPT Collector Unit Tests
//
// 9 suites, ~75 tests.
// Uses node:test + node:assert/strict.
// No network calls — all DNS mocked via injectable dnsResolver.
//
// Usage:
//   node --test signal-lab/signals/tlsrpt/tlsrpt-collector.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectTlsRpt, parseTlsRptRecord, parseRua, SIGNAL_ID, SIGNAL_VERSION } = require('./tlsrpt-collector');

// ── DNS mock helpers ───────────────────────────────────────────────────────────

function makeDns(records = [], errorCode = null) {
  return {
    resolveTxt: async () => {
      if (errorCode) throw Object.assign(new Error(`DNS error: ${errorCode}`), { code: errorCode });
      if (!records || records.length === 0) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return records.map(r => [r]);
    },
  };
}

function makeDnsWithCapture(records = []) {
  const calls = [];
  return {
    resolveTxt: async (qname) => {
      calls.push(qname);
      if (!records || records.length === 0) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return records.map(r => [r]);
    },
    _calls: calls,
  };
}

// ── Known good records ─────────────────────────────────────────────────────────

const RECORDS = {
  minimal:      'v=TLSRPTv1; rua=mailto:tlsrpt@example.com',
  mailto:       'v=TLSRPTv1; rua=mailto:reports@example.org',
  https:        'v=TLSRPTv1; rua=https://reports.example.org/tlsrpt',
  multi:        'v=TLSRPTv1; rua=mailto:a@example.com,mailto:b@example.com',
  mixed:        'v=TLSRPTv1; rua=mailto:reports@example.com,https://reports.example.com',
  unknown:      'v=TLSRPTv1; rua=mailto:reports@example.com; x-provider=mailguard',
};

// ── Expected output keys ───────────────────────────────────────────────────────

const EXPECTED_KEYS = new Set([
  'dns_tlsrpt_present', 'dns_collection_error',
  'dns_records', 'dns_record_count', 'dns_tlsrpt_record_count', 'dns_multiple_tlsrpt_records',
  'dns_parse_success', 'dns_syntax_errors', 'dns_version', 'dns_unknown_tags',
  'rua_raw', 'rua_uris', 'rua_count', 'rua_mailto_count', 'rua_https_count', 'rua_unknown_scheme_count',
]);

function assertSchema(r, label = '') {
  const actual  = new Set(Object.keys(r));
  const missing = [...EXPECTED_KEYS].filter(k => !actual.has(k));
  const extra   = [...actual].filter(k => !EXPECTED_KEYS.has(k));
  assert.deepEqual(missing, [], `${label} missing keys`);
  assert.deepEqual(extra,   [], `${label} extra keys`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: parseTlsRptRecord — valid records
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTlsRptRecord — valid records', () => {
  it('parses minimal record with mailto URI', () => {
    const r = parseTlsRptRecord(RECORDS.minimal);
    assert.equal(r.parse_success, true);
    assert.equal(r.dns_version,   'TLSRPTv1');
    assert.equal(r.rua_raw,       'mailto:tlsrpt@example.com');
    assert.deepEqual(r.rua_uris,  ['mailto:tlsrpt@example.com']);
    assert.equal(r.rua_count,     1);
    assert.equal(r.rua_mailto_count, 1);
    assert.equal(r.rua_https_count,  0);
    assert.equal(r.rua_unknown_scheme_count, 0);
    assert.deepEqual(r.syntax_errors, []);
    assert.deepEqual(r.dns_unknown_tags, {});
  });

  it('parses https reporting URI', () => {
    const r = parseTlsRptRecord(RECORDS.https);
    assert.equal(r.parse_success, true);
    assert.equal(r.rua_count,        1);
    assert.equal(r.rua_https_count,  1);
    assert.equal(r.rua_mailto_count, 0);
    assert.deepEqual(r.rua_uris, ['https://reports.example.org/tlsrpt']);
  });

  it('parses multiple mailto URIs', () => {
    const r = parseTlsRptRecord(RECORDS.multi);
    assert.equal(r.parse_success,    true);
    assert.equal(r.rua_count,        2);
    assert.equal(r.rua_mailto_count, 2);
    assert.deepEqual(r.rua_uris, ['mailto:a@example.com', 'mailto:b@example.com']);
  });

  it('parses mixed mailto + https URIs', () => {
    const r = parseTlsRptRecord(RECORDS.mixed);
    assert.equal(r.parse_success,    true);
    assert.equal(r.rua_count,        2);
    assert.equal(r.rua_mailto_count, 1);
    assert.equal(r.rua_https_count,  1);
    assert.deepEqual(r.rua_uris, ['mailto:reports@example.com', 'https://reports.example.com']);
  });

  it('preserves URI order as observed', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:c@x.com,mailto:a@x.com,mailto:b@x.com');
    assert.equal(r.rua_uris[0], 'mailto:c@x.com');
    assert.equal(r.rua_uris[1], 'mailto:a@x.com');
    assert.equal(r.rua_uris[2], 'mailto:b@x.com');
    assert.equal(r.rua_count,   3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: parseTlsRptRecord — version tag errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTlsRptRecord — version tag errors', () => {
  it('flags MISSING_VERSION when v= is absent', () => {
    const r = parseTlsRptRecord('rua=mailto:reports@example.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_VERSION'));
    assert.equal(r.dns_version, null);
  });

  it('flags INVALID_VERSION when v= is wrong value', () => {
    const r = parseTlsRptRecord('v=TLSRPTv2; rua=mailto:reports@example.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_VERSION'));
    assert.equal(r.dns_version, 'TLSRPTv2');
  });

  it('stores the observed (wrong) version value', () => {
    const r = parseTlsRptRecord('v=STSv1; rua=mailto:reports@example.com');
    assert.equal(r.dns_version, 'STSv1');
  });

  it('flags VERSION_NOT_FIRST when v= appears after other tags', () => {
    const r = parseTlsRptRecord('rua=mailto:reports@example.com; v=TLSRPTv1');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'VERSION_NOT_FIRST'));
    assert.equal(r.dns_version, 'TLSRPTv1');
  });

  it('returns EMPTY_RECORD for empty input', () => {
    const r = parseTlsRptRecord('');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_RECORD'));
    assert.equal(r.dns_version, null);
    assert.equal(r.rua_raw,     null);
    assert.deepEqual(r.rua_uris, []);
  });

  it('returns EMPTY_RECORD for whitespace-only input', () => {
    const r = parseTlsRptRecord('   ');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_RECORD'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: parseTlsRptRecord — RUA tag errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTlsRptRecord — RUA tag errors', () => {
  it('flags MISSING_RUA when rua= is absent', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_RUA'));
    assert.equal(r.rua_raw,   null);
    assert.equal(r.rua_count, 0);
  });

  it('flags EMPTY_RUA when rua= has empty value', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_RUA'));
    assert.equal(r.rua_raw,   '');
    assert.equal(r.rua_count, 0);
  });

  it('flags MALFORMED_URI when URI has no scheme', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=reports@example.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_URI'));
    assert.equal(r.rua_unknown_scheme_count, 1);
  });

  it('flags MALFORMED_URI for empty mailto: address', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_URI'));
    assert.equal(r.rua_mailto_count, 1);  // scheme is observable even if address is missing
    assert.equal(r.rua_count, 1);
  });

  it('flags UNKNOWN_SCHEME for non-mailto non-https scheme', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=ftp://reports.example.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'UNKNOWN_SCHEME'));
    assert.equal(r.rua_unknown_scheme_count, 1);
    assert.equal(r.rua_mailto_count,         0);
    assert.equal(r.rua_https_count,          0);
    assert.deepEqual(r.rua_uris, ['ftp://reports.example.com']);
  });

  it('counts known and unknown schemes independently in mixed URI list', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:a@x.com,ftp://b.com,https://c.com');
    assert.equal(r.rua_count,                3);
    assert.equal(r.rua_mailto_count,         1);
    assert.equal(r.rua_https_count,          1);
    assert.equal(r.rua_unknown_scheme_count, 1);
    assert.ok(r.syntax_errors.some(e => e.code === 'UNKNOWN_SCHEME'));
  });

  it('preserves all URIs even when some are malformed', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:good@x.com,NOTAURI,mailto:also@x.com');
    assert.equal(r.rua_uris.length, 3);
    assert.equal(r.rua_uris[0], 'mailto:good@x.com');
    assert.equal(r.rua_uris[1], 'NOTAURI');
    assert.equal(r.rua_uris[2], 'mailto:also@x.com');
    assert.equal(r.rua_mailto_count, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: parseTlsRptRecord — unknown tags and evidence preservation
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseTlsRptRecord — unknown tags and evidence', () => {
  it('preserves unknown tags in dns_unknown_tags', () => {
    const r = parseTlsRptRecord(RECORDS.unknown);
    assert.equal(r.parse_success, true);
    assert.deepEqual(r.dns_unknown_tags, { 'x-provider': 'mailguard' });
  });

  it('preserves multiple unknown tags', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:x@x.com; x-env=prod; x-ver=3');
    assert.equal(r.parse_success, true);
    assert.deepEqual(r.dns_unknown_tags, { 'x-env': 'prod', 'x-ver': '3' });
  });

  it('unknown tags do not cause parse_success=false', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:x@x.com; x-custom=anything');
    assert.equal(r.parse_success, true);
    assert.equal(r.syntax_errors.length, 0);
  });

  it('known tags are not in dns_unknown_tags', () => {
    const r = parseTlsRptRecord(RECORDS.minimal);
    assert.deepEqual(r.dns_unknown_tags, {});
    assert.ok(!('v' in r.dns_unknown_tags));
    assert.ok(!('rua' in r.dns_unknown_tags));
  });

  it('flags MALFORMED_TAG for tag with no = sign', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:x@x.com; notavalidtag');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_TAG'));
  });

  it('flags DUPLICATE_TAG for repeated tag', () => {
    const r = parseTlsRptRecord('v=TLSRPTv1; rua=mailto:a@x.com; rua=mailto:b@x.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'DUPLICATE_TAG'));
    // First rua= value is preserved
    assert.equal(r.rua_raw, 'mailto:a@x.com');
  });

  it('preserves rua_raw verbatim before URI splitting', () => {
    const raw = 'mailto:a@x.com,mailto:b@x.com,https://c.example.com';
    const r   = parseTlsRptRecord(`v=TLSRPTv1; rua=${raw}`);
    assert.equal(r.rua_raw, raw);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: collectTlsRpt — DNS states
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectTlsRpt — DNS states', () => {
  it('returns present=true when TLS-RPT record found', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([RECORDS.minimal]) });
    assert.equal(r.dns_tlsrpt_present,          true);
    assert.equal(r.dns_collection_error,         null);
    assert.equal(r.dns_tlsrpt_record_count,      1);
    assert.equal(r.dns_multiple_tlsrpt_records,  false);
  });

  it('returns present=false on ENODATA', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.equal(r.dns_tlsrpt_present,  false);
    assert.equal(r.dns_collection_error, null);
    assert.equal(r.dns_record_count,     0);
  });

  it('returns present=false on ENOTFOUND (NXDOMAIN)', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ENOTFOUND') });
    assert.equal(r.dns_tlsrpt_present,  false);
    assert.equal(r.dns_collection_error, null);
  });

  it('returns present=null on ETIMEDOUT → DNS_TIMEOUT', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assert.equal(r.dns_tlsrpt_present,   null);
    assert.equal(r.dns_collection_error, 'DNS_TIMEOUT');
    assert.equal(r.dns_record_count,     null);
    assert.equal(r.dns_tlsrpt_record_count, null);
    assert.equal(r.dns_multiple_tlsrpt_records, null);
  });

  it('returns present=null on ESERVFAIL → DNS_SERVFAIL', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ESERVFAIL') });
    assert.equal(r.dns_tlsrpt_present,   null);
    assert.equal(r.dns_collection_error, 'DNS_SERVFAIL');
  });

  it('returns present=null on unrecognised error → DNS_FAILURE', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'EUNKNOWN_XYZ') });
    assert.equal(r.dns_tlsrpt_present,   null);
    assert.equal(r.dns_collection_error, 'DNS_FAILURE');
  });

  it('returns present=false when TXT records exist but none qualify', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns(['v=spf1 -all', 'some-other=record']) });
    assert.equal(r.dns_tlsrpt_present,       false);
    assert.equal(r.dns_record_count,         2);
    assert.equal(r.dns_tlsrpt_record_count,  0);
    assert.deepEqual(r.dns_records,          ['v=spf1 -all', 'some-other=record']);
  });

  it('strips www. prefix before querying', async () => {
    const dns = makeDnsWithCapture([RECORDS.minimal]);
    await collectTlsRpt('www.example.com', { dnsResolver: dns });
    assert.equal(dns._calls[0], '_tlsrpt.example.com');
  });

  it('queries _tlsrpt.<domain> (not the apex)', async () => {
    const dns = makeDnsWithCapture([RECORDS.minimal]);
    await collectTlsRpt('example.com', { dnsResolver: dns });
    assert.equal(dns._calls[0], '_tlsrpt.example.com');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 6: collectTlsRpt — multiple records
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectTlsRpt — multiple records', () => {
  it('flags multiple TLS-RPT records with MULTIPLE_RECORDS error', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns([RECORDS.minimal, RECORDS.mailto]),
    });
    assert.equal(r.dns_tlsrpt_present,          true);
    assert.equal(r.dns_tlsrpt_record_count,     2);
    assert.equal(r.dns_multiple_tlsrpt_records, true);
    assert.ok(r.dns_syntax_errors.some(e => e.code === 'MULTIPLE_RECORDS'));
  });

  it('preserves all records in dns_records when multiple qualify', async () => {
    const REC_A = 'v=TLSRPTv1; rua=mailto:a@x.com';
    const REC_B = 'v=TLSRPTv1; rua=mailto:b@x.com';
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns([REC_A, REC_B]),
    });
    assert.ok(r.dns_records.includes(REC_A));
    assert.ok(r.dns_records.includes(REC_B));
    assert.equal(r.dns_records.length, 2);
  });

  it('parses first qualifying record when multiple exist', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns([
        'v=TLSRPTv1; rua=mailto:first@x.com',
        'v=TLSRPTv1; rua=mailto:second@x.com',
      ]),
    });
    assert.equal(r.rua_raw, 'mailto:first@x.com');
  });

  it('preserves non-qualifying TXT records alongside qualifying ones', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns(['v=spf1 -all', 'v=TLSRPTv1; rua=mailto:x@x.com']),
    });
    assert.equal(r.dns_tlsrpt_present,      true);
    assert.equal(r.dns_record_count,         2);
    assert.equal(r.dns_tlsrpt_record_count,  1);
    assert.equal(r.dns_records.length,       2);
    assert.ok(r.dns_records.includes('v=spf1 -all'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 7: collectTlsRpt — parsed field propagation
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectTlsRpt — parsed field propagation', () => {
  it('propagates dns_version from parsed record', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([RECORDS.minimal]) });
    assert.equal(r.dns_version, 'TLSRPTv1');
  });

  it('propagates rua fields from parsed record', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([RECORDS.mixed]) });
    assert.equal(r.rua_count,        2);
    assert.equal(r.rua_mailto_count, 1);
    assert.equal(r.rua_https_count,  1);
  });

  it('propagates unknown tags from parsed record', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([RECORDS.unknown]) });
    assert.deepEqual(r.dns_unknown_tags, { 'x-provider': 'mailguard' });
  });

  it('sets dns_parse_success = false for malformed first record', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns(['v=TLSRPTv1']),  // missing rua=
    });
    assert.equal(r.dns_tlsrpt_present, true);
    assert.equal(r.dns_parse_success,  false);
    assert.ok(r.dns_syntax_errors.some(e => e.code === 'MISSING_RUA'));
  });

  it('sets dns_parse_success = null when record is absent', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.equal(r.dns_parse_success, null);
    assert.equal(r.dns_version,       null);
  });

  it('sets rua fields to zero defaults when record is absent', async () => {
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.equal(r.rua_count,                0);
    assert.equal(r.rua_mailto_count,         0);
    assert.equal(r.rua_https_count,          0);
    assert.equal(r.rua_unknown_scheme_count, 0);
    assert.deepEqual(r.rua_uris,             []);
    assert.equal(r.rua_raw,                  null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 8: collectTlsRpt — evidence preservation
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectTlsRpt — evidence preservation', () => {
  it('preserves raw DNS record verbatim in dns_records', async () => {
    const RAW = 'v=TLSRPTv1; rua=mailto:tlsrpt@example.com';
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([RAW]) });
    assert.equal(r.dns_records[0], RAW);
  });

  it('preserves malformed record verbatim in dns_records', async () => {
    const MALFORMED = 'v=TLSRPTv1; NOTAVALIDTAG; rua=mailto:x@x.com';
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([MALFORMED]) });
    assert.equal(r.dns_records[0], MALFORMED);
    assert.equal(r.dns_tlsrpt_present, true);
  });

  it('preserves dns_records order as returned by resolver', async () => {
    const REC_A = 'v=TLSRPTv1; rua=mailto:zzz@x.com';
    const REC_B = 'v=TLSRPTv1; rua=mailto:aaa@x.com';
    const r = await collectTlsRpt('example.com', { dnsResolver: makeDns([REC_A, REC_B]) });
    assert.equal(r.dns_records[0], REC_A);
    assert.equal(r.dns_records[1], REC_B);
  });

  it('preserves rua_raw verbatim from first record', async () => {
    const RAW_RUA = 'mailto:first@x.com,https://second.x.com,mailto:third@x.com';
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns([`v=TLSRPTv1; rua=${RAW_RUA}`]),
    });
    assert.equal(r.rua_raw, RAW_RUA);
  });

  it('preserves URI list order from rua= value', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:c@x.com,mailto:a@x.com,mailto:b@x.com']),
    });
    assert.equal(r.rua_uris[0], 'mailto:c@x.com');
    assert.equal(r.rua_uris[1], 'mailto:a@x.com');
    assert.equal(r.rua_uris[2], 'mailto:b@x.com');
  });

  it('preserves unknown tags from first record', async () => {
    const r = await collectTlsRpt('example.com', {
      dnsResolver: makeDns(['v=TLSRPTv1; rua=mailto:x@x.com; x-region=eu; x-env=prod']),
    });
    assert.deepEqual(r.dns_unknown_tags, { 'x-region': 'eu', 'x-env': 'prod' });
  });

  it('dns_syntax_errors is always an array', async () => {
    for (const result of [
      await collectTlsRpt('a', { dnsResolver: makeDns([RECORDS.minimal]) }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ENODATA') }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ETIMEDOUT') }),
    ]) {
      assert.ok(Array.isArray(result.dns_syntax_errors), 'dns_syntax_errors must be array');
    }
  });

  it('dns_records is always an array', async () => {
    for (const result of [
      await collectTlsRpt('a', { dnsResolver: makeDns([RECORDS.minimal]) }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ENODATA') }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ETIMEDOUT') }),
    ]) {
      assert.ok(Array.isArray(result.dns_records), 'dns_records must be array');
    }
  });

  it('rua_uris is always an array', async () => {
    for (const result of [
      await collectTlsRpt('a', { dnsResolver: makeDns([RECORDS.minimal]) }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ENODATA') }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ETIMEDOUT') }),
    ]) {
      assert.ok(Array.isArray(result.rua_uris), 'rua_uris must be array');
    }
  });

  it('dns_unknown_tags is always a plain object', async () => {
    for (const result of [
      await collectTlsRpt('a', { dnsResolver: makeDns([RECORDS.minimal]) }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ENODATA') }),
      await collectTlsRpt('a', { dnsResolver: makeDns([], 'ETIMEDOUT') }),
    ]) {
      assert.ok(
        typeof result.dns_unknown_tags === 'object' && !Array.isArray(result.dns_unknown_tags),
        'dns_unknown_tags must be plain object'
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 9: Schema consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectTlsRpt — schema consistency', () => {
  const scenarios = [
    { name: 'present, valid',        dnsResolver: makeDns([RECORDS.minimal]) },
    { name: 'present, https URI',    dnsResolver: makeDns([RECORDS.https]) },
    { name: 'present, mixed URIs',   dnsResolver: makeDns([RECORDS.mixed]) },
    { name: 'present, unknown tags', dnsResolver: makeDns([RECORDS.unknown]) },
    { name: 'present, malformed rua',dnsResolver: makeDns(['v=TLSRPTv1; rua=']) },
    { name: 'present, missing rua',  dnsResolver: makeDns(['v=TLSRPTv1']) },
    { name: 'present, multiple records', dnsResolver: makeDns([RECORDS.minimal, RECORDS.mailto]) },
    { name: 'absent (ENODATA)',      dnsResolver: makeDns([], 'ENODATA') },
    { name: 'absent (ENOTFOUND)',    dnsResolver: makeDns([], 'ENOTFOUND') },
    { name: 'unknown (ETIMEDOUT)',   dnsResolver: makeDns([], 'ETIMEDOUT') },
    { name: 'unknown (ESERVFAIL)',   dnsResolver: makeDns([], 'ESERVFAIL') },
    { name: 'unknown (other error)', dnsResolver: makeDns([], 'EUNKNOWN') },
    { name: 'non-qualifying TXT',    dnsResolver: makeDns(['v=spf1 -all']) },
  ];

  for (const s of scenarios) {
    it(`returns 16 expected keys: ${s.name}`, async () => {
      const r = await collectTlsRpt('example.com', { dnsResolver: s.dnsResolver });
      assertSchema(r, s.name);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 10: parseRua — direct unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseRua — direct unit tests', () => {
  it('returns empty result for null input', () => {
    const r = parseRua(null);
    assert.equal(r.rua_count, 0);
    assert.deepEqual(r.rua_uris, []);
    assert.equal(r.errors.length, 0);
  });

  it('flags EMPTY_RUA for empty string', () => {
    const r = parseRua('');
    assert.equal(r.rua_count, 0);
    assert.ok(r.errors.some(e => e.code === 'EMPTY_RUA'));
  });

  it('flags EMPTY_RUA for whitespace-only string', () => {
    const r = parseRua('   ');
    assert.ok(r.errors.some(e => e.code === 'EMPTY_RUA'));
  });

  it('correctly counts three URI types in a single list', () => {
    const r = parseRua('mailto:a@x.com,https://b.com,ftp://c.com');
    assert.equal(r.rua_count,                3);
    assert.equal(r.rua_mailto_count,         1);
    assert.equal(r.rua_https_count,          1);
    assert.equal(r.rua_unknown_scheme_count, 1);
  });

  it('handles multiple mailto URIs', () => {
    const r = parseRua('mailto:a@x.com,mailto:b@x.com,mailto:c@x.com');
    assert.equal(r.rua_mailto_count, 3);
    assert.equal(r.rua_https_count,  0);
    assert.equal(r.rua_count,        3);
  });

  it('handles multiple https URIs', () => {
    const r = parseRua('https://a.com,https://b.com');
    assert.equal(r.rua_https_count,  2);
    assert.equal(r.rua_mailto_count, 0);
  });

  it('filters out empty segments after split', () => {
    const r = parseRua('mailto:a@x.com,,mailto:b@x.com');
    assert.equal(r.rua_count, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 11: Signal metadata
// ═══════════════════════════════════════════════════════════════════════════════

describe('signal metadata', () => {
  it('exports SIGNAL_ID = tls-rpt', () => {
    assert.equal(SIGNAL_ID, 'tls-rpt');
  });

  it('exports SIGNAL_VERSION = 1', () => {
    assert.equal(SIGNAL_VERSION, 1);
  });
});
