'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseSpfRecord, collectSpf } = require('./spf-collector');

// ── parseSpfRecord — pure function tests ──────────────────────────────────────

describe('parseSpfRecord — valid records', () => {
  test('minimal hard-fail record', () => {
    const result = parseSpfRecord('v=spf1 include:spf.protection.outlook.com -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.mechanism, '-all');
    assert.equal(result.lookupCount, 1);
    assert.equal(result.includeCount, 1);
  });

  test('soft-fail all mechanism', () => {
    const result = parseSpfRecord('v=spf1 include:mailgun.org ~all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.mechanism, '~all');
    assert.equal(result.lookupCount, 1);
    assert.equal(result.includeCount, 1);
  });

  test('neutral all mechanism', () => {
    const result = parseSpfRecord('v=spf1 ?all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.mechanism, '?all');
    assert.equal(result.lookupCount, 0);
    assert.equal(result.includeCount, 0);
  });

  test('permissive plus-all', () => {
    const result = parseSpfRecord('v=spf1 +all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.mechanism, '+all');
  });

  test('ip4 range with no lookups', () => {
    const result = parseSpfRecord('v=spf1 ip4:192.168.1.0/24 -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.lookupCount, 0);
    assert.equal(result.includeCount, 0);
  });

  test('multiple includes counted correctly', () => {
    const result = parseSpfRecord('v=spf1 include:mailgun.org include:sendgrid.net include:_spf.google.com -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.mechanism, '-all');
    assert.equal(result.lookupCount, 3);
    assert.equal(result.includeCount, 3);
  });

  test('a and mx mechanisms contribute to lookup count', () => {
    const result = parseSpfRecord('v=spf1 a mx ip4:10.0.0.1 -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.lookupCount, 2);
  });

  test('ip4 without cidr', () => {
    const result = parseSpfRecord('v=spf1 ip4:203.0.113.0 -all');
    assert.equal(result.errors.length, 0);
  });

  test('ip6 address present', () => {
    const result = parseSpfRecord('v=spf1 ip6:2001:db8::/32 -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.lookupCount, 0);
  });

  test('qualifier on include mechanism', () => {
    const result = parseSpfRecord('v=spf1 +include:spf.example.com -all');
    assert.equal(result.errors.length, 0);
    assert.equal(result.includeCount, 1);
    assert.equal(result.lookupCount, 1);
  });

  test('redirect modifier replaces all — no MISSING_ALL_MECHANISM', () => {
    const result = parseSpfRecord('v=spf1 redirect=spf.example.com');
    // RFC 7208 §6.1: redirect= substitutes for the whole record; all is not required
    assert.equal(result.errors.length, 0);
    assert.equal(result.lookupCount, 1);
  });
});

describe('parseSpfRecord — syntax errors', () => {
  test('include without domain → MALFORMED_INCLUDE', () => {
    const result = parseSpfRecord('v=spf1 include: -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('MALFORMED_INCLUDE'), `expected MALFORMED_INCLUDE, got: ${JSON.stringify(codes)}`);
  });

  test('no all mechanism → MISSING_ALL_MECHANISM', () => {
    const result = parseSpfRecord('v=spf1 include:spf.example.com');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('MISSING_ALL_MECHANISM'));
  });

  test('all not last → ALL_NOT_LAST', () => {
    const result = parseSpfRecord('v=spf1 -all include:spf.example.com');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('ALL_NOT_LAST'), `expected ALL_NOT_LAST, got: ${JSON.stringify(codes)}`);
  });

  test('duplicate all → DUPLICATE_ALL', () => {
    const result = parseSpfRecord('v=spf1 ~all -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('DUPLICATE_ALL'));
  });

  test('unknown mechanism → UNKNOWN_MECHANISM', () => {
    const result = parseSpfRecord('v=spf1 bogus:example.com -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('UNKNOWN_MECHANISM'));
  });

  test('redirect without domain → MALFORMED_REDIRECT', () => {
    const result = parseSpfRecord('v=spf1 redirect= -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('MALFORMED_REDIRECT'));
  });

  test('invalid IPv4 address → INVALID_IP4', () => {
    const result = parseSpfRecord('v=spf1 ip4:999.999.999.999 -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('INVALID_IP4'));
  });

  test('invalid IPv4 CIDR prefix → INVALID_IP4_CIDR', () => {
    const result = parseSpfRecord('v=spf1 ip4:192.168.1.0/33 -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('INVALID_IP4_CIDR'));
  });

  test('11 includes → LOOKUP_LIMIT_EXCEEDED', () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:host${i}.example.com`).join(' ');
    const result = parseSpfRecord(`v=spf1 ${includes} -all`);
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('LOOKUP_LIMIT_EXCEEDED'));
    assert.equal(result.lookupCount, 11);
  });

  test('exactly 10 includes → no LOOKUP_LIMIT_EXCEEDED', () => {
    const includes = Array.from({ length: 10 }, (_, i) => `include:host${i}.example.com`).join(' ');
    const result = parseSpfRecord(`v=spf1 ${includes} -all`);
    const codes = result.errors.map(e => e.code);
    assert.ok(!codes.includes('LOOKUP_LIMIT_EXCEEDED'), 'should not flag 10 lookups as exceeded');
    assert.equal(result.lookupCount, 10);
  });

  test('record not beginning with v=spf1 → INVALID_VERSION', () => {
    const result = parseSpfRecord('v=spf2 include:example.com -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('INVALID_VERSION'));
    assert.equal(result.mechanism, null);
  });

  test('ip4 without value → MALFORMED_IP4', () => {
    const result = parseSpfRecord('v=spf1 ip4: -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('MALFORMED_IP4'));
  });

  test('exists without domain → MALFORMED_EXISTS', () => {
    const result = parseSpfRecord('v=spf1 exists: -all');
    const codes = result.errors.map(e => e.code);
    assert.ok(codes.includes('MALFORMED_EXISTS'));
  });
});

// ── collectSpf — DNS-injected tests ───────────────────────────────────────────

function makeDns(txtRecords) {
  return {
    resolveTxt: async () => txtRecords.map(r => [r]),
  };
}

function makeDnsThrow(errorCode) {
  return {
    resolveTxt: async () => { throw Object.assign(new Error('DNS error'), { code: errorCode }); },
  };
}

describe('collectSpf — SPF present', () => {
  test('valid hard-fail record returns correct facts', async () => {
    const dnsResolver = makeDns(['v=spf1 include:spf.protection.outlook.com -all']);
    const facts = await collectSpf('example.com', { dnsResolver });

    assert.equal(facts.spf_present, true);
    assert.equal(facts.spf_collection_error, null);
    assert.equal(facts.spf_record, 'v=spf1 include:spf.protection.outlook.com -all');
    assert.equal(facts.spf_record_count, 1);
    assert.equal(facts.spf_parse_success, true);
    assert.deepEqual(facts.spf_syntax_errors, []);
    assert.equal(facts.spf_mechanism, '-all');
    assert.equal(facts.spf_lookup_count, 1);
    assert.equal(facts.spf_multiple_records, false);
    assert.equal(facts.spf_include_count, 1);
  });

  test('soft-fail record returns mechanism ~all', async () => {
    const dnsResolver = makeDns(['v=spf1 include:mail.example.com ~all']);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, true);
    assert.equal(facts.spf_mechanism, '~all');
    assert.equal(facts.spf_record_count, 1);
  });

  test('record with syntax error: spf_present true, parse_success true, error reported', async () => {
    const dnsResolver = makeDns(['v=spf1 include: -all']);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, true);
    assert.equal(facts.spf_parse_success, true);
    const codes = facts.spf_syntax_errors.map(e => e.code);
    assert.ok(codes.includes('MALFORMED_INCLUDE'));
  });

  test('chunked TXT record is joined before parsing', async () => {
    const dnsResolver = {
      resolveTxt: async () => [['v=spf1 include:spf.example.com ', '-all']],
    };
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, true);
    assert.equal(facts.spf_mechanism, '-all');
  });

  test('www prefix is stripped before DNS lookup', async () => {
    let queriedDomain;
    const dnsResolver = {
      resolveTxt: async (d) => {
        queriedDomain = d;
        return [['v=spf1 -all']];
      },
    };
    await collectSpf('www.example.com', { dnsResolver });
    assert.equal(queriedDomain, 'example.com');
  });
});

describe('collectSpf — SPF absent (DNS resolved, no record)', () => {
  test('no SPF among TXT records: spf_present false, spf_record_count 0', async () => {
    const dnsResolver = makeDns(['v=DMARC1; p=none; rua=mailto:dmarc@example.com']);
    const facts = await collectSpf('example.com', { dnsResolver });

    assert.equal(facts.spf_present, false);
    assert.equal(facts.spf_collection_error, null);
    assert.equal(facts.spf_record, null);
    assert.equal(facts.spf_record_count, 0);
    assert.equal(facts.spf_parse_success, null);
    assert.deepEqual(facts.spf_syntax_errors, []);
    assert.equal(facts.spf_mechanism, null);
    assert.equal(facts.spf_lookup_count, 0);
    assert.equal(facts.spf_multiple_records, false);
    assert.equal(facts.spf_include_count, 0);
  });

  test('empty TXT record set: spf_present false, spf_record_count 0', async () => {
    const dnsResolver = makeDns([]);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, false);
    assert.equal(facts.spf_collection_error, null);
    assert.equal(facts.spf_record_count, 0);
    assert.equal(facts.spf_multiple_records, false);
  });

  test('ENODATA (no TXT records in DNS): spf_present false, no collection error', async () => {
    const dnsResolver = makeDnsThrow('ENODATA');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, false);
    assert.equal(facts.spf_collection_error, null);
    assert.equal(facts.spf_record_count, 0);
  });

  test('ENOTFOUND (domain does not exist): spf_present false, no collection error', async () => {
    const dnsResolver = makeDnsThrow('ENOTFOUND');
    const facts = await collectSpf('nonexistent.invalid', { dnsResolver });
    assert.equal(facts.spf_present, false);
    assert.equal(facts.spf_collection_error, null);
    assert.equal(facts.spf_record_count, 0);
  });
});

describe('collectSpf — SPF unknown (DNS did not respond reliably)', () => {
  test('DNS timeout: spf_present null, spf_collection_error DNS_TIMEOUT', async () => {
    const dnsResolver = makeDnsThrow('ETIMEDOUT');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, null);
    assert.equal(facts.spf_collection_error, 'DNS_TIMEOUT');
    assert.equal(facts.spf_record, null);
    assert.equal(facts.spf_record_count, null);
    assert.equal(facts.spf_parse_success, null);
    assert.equal(facts.spf_multiple_records, null);
  });

  test('DNS SERVFAIL: spf_present null, spf_collection_error DNS_SERVFAIL', async () => {
    const dnsResolver = makeDnsThrow('ESERVFAIL');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, null);
    assert.equal(facts.spf_collection_error, 'DNS_SERVFAIL');
    assert.equal(facts.spf_record_count, null);
  });

  test('unrecognised DNS error: spf_present null, spf_collection_error DNS_FAILURE', async () => {
    const dnsResolver = makeDnsThrow('ECONNREFUSED');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_present, null);
    assert.equal(facts.spf_collection_error, 'DNS_FAILURE');
    assert.equal(facts.spf_record_count, null);
  });

  test('uncertain result contains empty syntax_errors array', async () => {
    const dnsResolver = makeDnsThrow('ETIMEDOUT');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.deepEqual(facts.spf_syntax_errors, []);
  });
});

describe('collectSpf — spf_record_count', () => {
  test('spf_record_count 0 when no SPF records', async () => {
    const dnsResolver = makeDns([]);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_record_count, 0);
    assert.equal(facts.spf_multiple_records, false);
  });

  test('spf_record_count 1 when one SPF record', async () => {
    const dnsResolver = makeDns(['v=spf1 -all']);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_record_count, 1);
    assert.equal(facts.spf_multiple_records, false);
  });

  test('spf_record_count 2 when two SPF records', async () => {
    const dnsResolver = makeDns([
      'v=spf1 include:spf1.example.com -all',
      'v=spf1 include:spf2.example.com ~all',
    ]);
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_record_count, 2);
    assert.equal(facts.spf_multiple_records, true);
    assert.equal(facts.spf_present, true);
    const codes = facts.spf_syntax_errors.map(e => e.code);
    assert.ok(codes.includes('MULTIPLE_SPF_RECORDS'));
    // Uses the first record
    assert.equal(facts.spf_record, 'v=spf1 include:spf1.example.com -all');
  });

  test('spf_record_count null when DNS uncertain', async () => {
    const dnsResolver = makeDnsThrow('ETIMEDOUT');
    const facts = await collectSpf('example.com', { dnsResolver });
    assert.equal(facts.spf_record_count, null);
    assert.equal(facts.spf_multiple_records, null);
  });
});

describe('collectSpf — output schema', () => {
  test('output contains exactly the ten required fact keys', async () => {
    const dnsResolver = makeDns(['v=spf1 -all']);
    const facts = await collectSpf('example.com', { dnsResolver });
    const expectedKeys = [
      'spf_present', 'spf_collection_error',
      'spf_record', 'spf_record_count',
      'spf_parse_success', 'spf_syntax_errors',
      'spf_mechanism', 'spf_lookup_count',
      'spf_multiple_records', 'spf_include_count',
    ];
    assert.deepEqual(Object.keys(facts).sort(), expectedKeys.sort());
  });

  test('key set is identical across all three spf_present states', async () => {
    const presentFacts  = await collectSpf('example.com', { dnsResolver: makeDns(['v=spf1 -all']) });
    const absentFacts   = await collectSpf('example.com', { dnsResolver: makeDns([]) });
    const uncertainFacts = await collectSpf('example.com', { dnsResolver: makeDnsThrow('ETIMEDOUT') });

    const presentKeys  = Object.keys(presentFacts).sort().join(',');
    const absentKeys   = Object.keys(absentFacts).sort().join(',');
    const uncertainKeys = Object.keys(uncertainFacts).sort().join(',');

    assert.equal(presentKeys, absentKeys);
    assert.equal(presentKeys, uncertainKeys);
  });
});
