'use strict';

// SOT-DMARC-001 — DMARC Collector Unit Tests
//
// 7 suites, ~40 tests.
// Uses node:test + node:assert/strict.
// No network calls — all DNS mocked via injectable dnsResolver.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { collectDmarc, parseDmarcRecord, SIGNAL_ID, SIGNAL_VERSION } = require('./dmarc-collector');

// ── DNS mock helpers ───────────────────────────────────────────────────────────
//
// makeDns(records, errorCode)
//   records:   array of strings to return as TXT records at any qname, OR null
//   errorCode: if set, throw this code for every query
//
// Each string becomes a single-chunk TXT record [string].

function makeDns(records = [], errorCode = null) {
  return {
    resolveTxt: async () => {
      if (errorCode) {
        throw Object.assign(new Error(`DNS error: ${errorCode}`), { code: errorCode });
      }
      if (!records || records.length === 0) {
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      }
      return records.map(r => [r]);
    },
  };
}

// Verify that resolveTxt was called with the expected qname
function makeDnsWithCapture(records = []) {
  const calls = [];
  const resolver = {
    resolveTxt: async (qname) => {
      calls.push(qname);
      if (!records || records.length === 0) {
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      }
      return records.map(r => [r]);
    },
    _calls: calls,
  };
  return resolver;
}

// ── Known good record strings ──────────────────────────────────────────────────

const RECORDS = {
  minimal:     'v=DMARC1; p=none',
  quarantine:  'v=DMARC1; p=quarantine',
  reject:      'v=DMARC1; p=reject',
  withRua:     'v=DMARC1; p=reject; rua=mailto:dmarc@example.com',
  full:        'v=DMARC1; p=reject; sp=none; adkim=s; aspf=s; pct=100; rua=mailto:rua@example.com; ruf=mailto:ruf@example.com; fo=1; ri=86400; rf=afrf',
  twoRua:      'v=DMARC1; p=none; rua=mailto:a@example.com,mailto:b@example.com',
  withSp:      'v=DMARC1; p=quarantine; sp=reject',
  pctZero:     'v=DMARC1; p=none; pct=0',
  alignRelax:  'v=DMARC1; p=none; adkim=r; aspf=r',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: parseDmarcRecord — valid records
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseDmarcRecord — valid records', () => {
  it('parses minimal record (v=DMARC1; p=none)', () => {
    const r = parseDmarcRecord(RECORDS.minimal);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_version, 'DMARC1');
    assert.equal(r.dmarc_policy, 'none');
    assert.equal(r.syntax_errors.length, 0);
  });

  it('parses p=quarantine', () => {
    const r = parseDmarcRecord(RECORDS.quarantine);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_policy, 'quarantine');
  });

  it('parses p=reject', () => {
    const r = parseDmarcRecord(RECORDS.reject);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_policy, 'reject');
  });

  it('extracts rua= tag and counts URIs', () => {
    const r = parseDmarcRecord(RECORDS.withRua);
    assert.equal(r.dmarc_rua, 'mailto:dmarc@example.com');
    assert.equal(r.dmarc_rua_count, 1);
    assert.equal(r.dmarc_ruf, null);
    assert.equal(r.dmarc_ruf_count, 0);
  });

  it('counts multiple URIs in rua=', () => {
    const r = parseDmarcRecord(RECORDS.twoRua);
    assert.equal(r.dmarc_rua_count, 2);
    assert.equal(r.dmarc_rua, 'mailto:a@example.com,mailto:b@example.com');
  });

  it('parses full record with all optional tags', () => {
    const r = parseDmarcRecord(RECORDS.full);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_policy, 'reject');
    assert.equal(r.dmarc_subdomain_policy, 'none');
    assert.equal(r.dmarc_adkim, 's');
    assert.equal(r.dmarc_aspf, 's');
    assert.equal(r.dmarc_pct, 100);
    assert.equal(r.dmarc_rua_count, 1);
    assert.equal(r.dmarc_ruf_count, 1);
    assert.equal(r.dmarc_fo, '1');
    assert.equal(r.dmarc_ri, 86400);
    assert.equal(r.dmarc_rf, 'afrf');
  });

  it('absent optional tags return null (not RFC defaults)', () => {
    const r = parseDmarcRecord(RECORDS.minimal);
    assert.equal(r.dmarc_subdomain_policy, null);
    assert.equal(r.dmarc_adkim, null);
    assert.equal(r.dmarc_aspf, null);
    assert.equal(r.dmarc_pct, null);
    assert.equal(r.dmarc_rua, null);
    assert.equal(r.dmarc_ruf, null);
    assert.equal(r.dmarc_fo, null);
    assert.equal(r.dmarc_ri, null);
    assert.equal(r.dmarc_rf, null);
  });

  it('pct=0 is valid and stored as 0', () => {
    const r = parseDmarcRecord(RECORDS.pctZero);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_pct, 0);
  });

  it('parses sp= subdomain policy', () => {
    const r = parseDmarcRecord(RECORDS.withSp);
    assert.equal(r.parse_success, true);
    assert.equal(r.dmarc_subdomain_policy, 'reject');
    assert.equal(r.dmarc_policy, 'quarantine');
  });

  it('normalises policy values to lowercase', () => {
    const r = parseDmarcRecord('v=DMARC1; p=Reject; sp=None; adkim=R; aspf=S');
    assert.equal(r.dmarc_policy, 'reject');
    assert.equal(r.dmarc_subdomain_policy, 'none');
    assert.equal(r.dmarc_adkim, 'r');
    assert.equal(r.dmarc_aspf, 's');
    assert.equal(r.parse_success, true);
  });

  it('parses adkim=r and aspf=r as relaxed', () => {
    const r = parseDmarcRecord(RECORDS.alignRelax);
    assert.equal(r.dmarc_adkim, 'r');
    assert.equal(r.dmarc_aspf, 'r');
    assert.equal(r.parse_success, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: parseDmarcRecord — syntax errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseDmarcRecord — syntax errors', () => {
  it('MISSING_VERSION when v= is absent', () => {
    const r = parseDmarcRecord('p=none');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_VERSION'));
  });

  it('INVALID_VERSION when v=DMARC2', () => {
    const r = parseDmarcRecord('v=DMARC2; p=none');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_VERSION'));
  });

  it('VERSION_NOT_FIRST when p= precedes v=', () => {
    const r = parseDmarcRecord('p=none; v=DMARC1');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'VERSION_NOT_FIRST'));
  });

  it('MISSING_POLICY when p= is absent', () => {
    const r = parseDmarcRecord('v=DMARC1; rua=mailto:x@x.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_POLICY'));
  });

  it('INVALID_POLICY when p=accept', () => {
    const r = parseDmarcRecord('v=DMARC1; p=accept');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_POLICY'));
    assert.equal(r.dmarc_policy, null);
  });

  it('INVALID_SUBDOMAIN_POLICY when sp=all', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; sp=all');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_SUBDOMAIN_POLICY'));
    assert.equal(r.dmarc_subdomain_policy, null);
  });

  it('INVALID_ADKIM when adkim=x', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; adkim=x');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_ADKIM'));
    assert.equal(r.dmarc_adkim, null);
  });

  it('INVALID_ASPF when aspf=x', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; aspf=x');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_ASPF'));
    assert.equal(r.dmarc_aspf, null);
  });

  it('INVALID_PCT when pct=200', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; pct=200');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_PCT'));
    assert.equal(r.dmarc_pct, null);
  });

  it('INVALID_PCT when pct=abc', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; pct=abc');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_PCT'));
    assert.equal(r.dmarc_pct, null);
  });

  it('DUPLICATE_TAG when p= appears twice', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; p=reject');
    assert.equal(r.parse_success, false);
    const dup = r.syntax_errors.filter(e => e.code === 'DUPLICATE_TAG');
    assert.equal(dup.length, 1);
    assert.equal(r.dmarc_policy, 'none'); // first occurrence used
  });

  it('MALFORMED_TAG when a tag has no = sign', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; badtag');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_TAG'));
  });

  it('EMPTY_RECORD for empty string', () => {
    const r = parseDmarcRecord('');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_RECORD'));
  });

  it('INVALID_RI when ri is not an integer', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none; ri=daily');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_RI'));
    assert.equal(r.dmarc_ri, null);
  });

  it('collects multiple errors in a single pass', () => {
    const r = parseDmarcRecord('v=DMARC1; p=invalid; adkim=x; pct=999');
    assert.equal(r.parse_success, false);
    const codes = r.syntax_errors.map(e => e.code);
    assert.ok(codes.includes('INVALID_POLICY'));
    assert.ok(codes.includes('INVALID_ADKIM'));
    assert.ok(codes.includes('INVALID_PCT'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: collectDmarc — record present
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectDmarc — record present', () => {
  it('returns dmarc_present=true when a v=DMARC1 record exists', async () => {
    const dns = makeDns([RECORDS.reject]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, true);
    assert.equal(r.dmarc_collection_error, null);
    assert.equal(r.dmarc_records.length, 1);
    assert.equal(r.dmarc_record_count, 1);
    assert.equal(r.dmarc_multiple_records, false);
    assert.equal(r.dmarc_policy, 'reject');
  });

  it('strips www. before querying', async () => {
    const dns = makeDnsWithCapture([RECORDS.minimal]);
    await collectDmarc('www.example.com', { dnsResolver: dns });
    assert.equal(dns._calls[0], '_dmarc.example.com');
  });

  it('queries _dmarc.<domain>', async () => {
    const dns = makeDnsWithCapture([RECORDS.minimal]);
    await collectDmarc('university.ac.uk', { dnsResolver: dns });
    assert.equal(dns._calls[0], '_dmarc.university.ac.uk');
  });

  it('extracts rua= when present', async () => {
    const dns = makeDns([RECORDS.withRua]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_rua, 'mailto:dmarc@example.com');
    assert.equal(r.dmarc_rua_count, 1);
  });

  it('preserves the full raw record in dmarc_records[0]', async () => {
    const dns = makeDns([RECORDS.full]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_records[0], RECORDS.full);
  });

  it('ignores non-v=DMARC1 TXT records at _dmarc location', async () => {
    const dns = makeDns(['some-other-txt=value', RECORDS.reject]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, true);
    assert.equal(r.dmarc_record_count, 1);
    assert.equal(r.dmarc_records[0], RECORDS.reject);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: collectDmarc — record absent
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectDmarc — record absent', () => {
  it('ENODATA -> dmarc_present=false, no error', async () => {
    const dns = makeDns([], 'ENODATA');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, false);
    assert.equal(r.dmarc_collection_error, null);
    assert.equal(r.dmarc_record_count, 0);
    assert.equal(r.dmarc_multiple_records, false);
    assert.equal(r.dmarc_parse_success, null);
  });

  it('ENOTFOUND -> dmarc_present=false, no error', async () => {
    const dns = makeDns([], 'ENOTFOUND');
    const r   = await collectDmarc('no-domain.invalid', { dnsResolver: dns });
    assert.equal(r.dmarc_present, false);
    assert.equal(r.dmarc_collection_error, null);
  });

  it('TXT records exist but none is v=DMARC1 -> dmarc_present=false', async () => {
    const dns = makeDns(['v=spf1 -all', 'other-record=xyz']);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, false);
    assert.equal(r.dmarc_records.length, 0);
  });

  it('absent state: all tag fields are null, counts are 0', async () => {
    const dns = makeDns([], 'ENODATA');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_version,          null);
    assert.equal(r.dmarc_policy,           null);
    assert.equal(r.dmarc_subdomain_policy, null);
    assert.equal(r.dmarc_adkim,            null);
    assert.equal(r.dmarc_aspf,             null);
    assert.equal(r.dmarc_pct,              null);
    assert.equal(r.dmarc_rua,              null);
    assert.equal(r.dmarc_ruf,              null);
    assert.equal(r.dmarc_rua_count,        0);
    assert.equal(r.dmarc_ruf_count,        0);
    assert.equal(r.dmarc_fo,               null);
    assert.equal(r.dmarc_ri,               null);
    assert.equal(r.dmarc_rf,               null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: collectDmarc — DNS errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectDmarc — DNS errors', () => {
  it('ETIMEDOUT -> dmarc_present=null, dmarc_collection_error=DNS_TIMEOUT', async () => {
    const dns = makeDns([], 'ETIMEDOUT');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, null);
    assert.equal(r.dmarc_collection_error, 'DNS_TIMEOUT');
    assert.equal(r.dmarc_record_count, null);
    assert.equal(r.dmarc_multiple_records, null);
  });

  it('ESERVFAIL -> dmarc_present=null, dmarc_collection_error=DNS_SERVFAIL', async () => {
    const dns = makeDns([], 'ESERVFAIL');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, null);
    assert.equal(r.dmarc_collection_error, 'DNS_SERVFAIL');
  });

  it('ECONNREFUSED -> dmarc_present=null, dmarc_collection_error=DNS_FAILURE', async () => {
    const dns = makeDns([], 'ECONNREFUSED');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, null);
    assert.equal(r.dmarc_collection_error, 'DNS_FAILURE');
  });

  it('unknown error code -> DNS_FAILURE', async () => {
    const dns = makeDns([], 'EUNKNOWN_XYZ');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, null);
    assert.equal(r.dmarc_collection_error, 'DNS_FAILURE');
  });

  it('unknown state: all tag fields are null, counts are 0', async () => {
    const dns = makeDns([], 'ETIMEDOUT');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_version,   null);
    assert.equal(r.dmarc_policy,    null);
    assert.equal(r.dmarc_rua,       null);
    assert.equal(r.dmarc_rua_count, 0);
    assert.equal(r.dmarc_ruf_count, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 6: collectDmarc — multiple records
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectDmarc — multiple records', () => {
  const RECORD_A = 'v=DMARC1; p=reject; rua=mailto:a@example.com';
  const RECORD_B = 'v=DMARC1; p=none; rua=mailto:b@example.com';

  it('both records are preserved in dmarc_records[]', async () => {
    const dns = makeDns([RECORD_A, RECORD_B]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_present, true);
    assert.equal(r.dmarc_record_count, 2);
    assert.equal(r.dmarc_multiple_records, true);
    assert.equal(r.dmarc_records[0], RECORD_A);
    assert.equal(r.dmarc_records[1], RECORD_B);
  });

  it('MULTIPLE_RECORDS is in dmarc_syntax_errors', async () => {
    const dns = makeDns([RECORD_A, RECORD_B]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.ok(r.dmarc_syntax_errors.some(e => e.code === 'MULTIPLE_RECORDS'));
  });

  it('tags are parsed from dmarc_records[0] (first record)', async () => {
    const dns = makeDns([RECORD_A, RECORD_B]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_policy, 'reject');    // from RECORD_A
    assert.equal(r.dmarc_rua, 'mailto:a@example.com');
  });

  it('parse_success reflects first record only (not MULTIPLE_RECORDS)', async () => {
    const dns = makeDns([RECORD_A, RECORD_B]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    // RECORD_A is a valid record so parse_success = true
    // even though MULTIPLE_RECORDS is in syntax_errors
    assert.equal(r.dmarc_parse_success, true);
  });

  it('non-DMARC TXT records are excluded from multiple-record count', async () => {
    const dns = makeDns(['v=spf1 -all', RECORD_A]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    assert.equal(r.dmarc_record_count, 1);
    assert.equal(r.dmarc_multiple_records, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 7: collectDmarc — output schema
// ═══════════════════════════════════════════════════════════════════════════════

const EXPECTED_KEYS = new Set([
  'dmarc_present', 'dmarc_collection_error', 'dmarc_records',
  'dmarc_record_count', 'dmarc_multiple_records', 'dmarc_parse_success',
  'dmarc_syntax_errors', 'dmarc_version', 'dmarc_policy',
  'dmarc_subdomain_policy', 'dmarc_adkim', 'dmarc_aspf', 'dmarc_pct',
  'dmarc_rua', 'dmarc_ruf', 'dmarc_rua_count', 'dmarc_ruf_count',
  'dmarc_fo', 'dmarc_ri', 'dmarc_rf',
]);

describe('collectDmarc — output schema', () => {
  it('present result has exactly the 20 expected keys', async () => {
    const dns = makeDns([RECORDS.reject]);
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    const actual = new Set(Object.keys(r));
    assert.deepEqual(actual, EXPECTED_KEYS);
  });

  it('absent result has exactly the 20 expected keys', async () => {
    const dns = makeDns([], 'ENODATA');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    const actual = new Set(Object.keys(r));
    assert.deepEqual(actual, EXPECTED_KEYS);
  });

  it('unknown result has exactly the 20 expected keys', async () => {
    const dns = makeDns([], 'ETIMEDOUT');
    const r   = await collectDmarc('example.com', { dnsResolver: dns });
    const actual = new Set(Object.keys(r));
    assert.deepEqual(actual, EXPECTED_KEYS);
  });

  it('module exports SIGNAL_ID=dmarc and SIGNAL_VERSION=1', () => {
    assert.equal(SIGNAL_ID, 'dmarc');
    assert.equal(SIGNAL_VERSION, 1);
  });

  it('dmarc_syntax_errors is always an array', async () => {
    for (const code of ['ENODATA', 'ETIMEDOUT', null]) {
      const dns = code ? makeDns([], code) : makeDns([RECORDS.reject]);
      const r   = await collectDmarc('example.com', { dnsResolver: dns });
      assert.ok(Array.isArray(r.dmarc_syntax_errors));
    }
  });

  it('dmarc_records is always an array', async () => {
    for (const code of ['ENODATA', 'ETIMEDOUT', null]) {
      const dns = code ? makeDns([], code) : makeDns([RECORDS.reject]);
      const r   = await collectDmarc('example.com', { dnsResolver: dns });
      assert.ok(Array.isArray(r.dmarc_records));
    }
  });
});
