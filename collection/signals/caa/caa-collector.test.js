'use strict';

// SOT-CAA-001 — Collector Test Suite
//
// Tests use injectable mock resolvers exclusively.
// No live DNS queries are made in this suite.
//
// Usage:  node --test backend/signal-lab/signals/caa/caa-collector.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { collectCaa, parseCaaRecord } = require('./caa-collector');

// ── Schema ────────────────────────────────────────────────────────────────────

const EXPECTED_KEYS = new Set([
  'dns_caa_present', 'caa_collection_error',
  'caa_records', 'caa_record_count',
  'caa_issue_count', 'caa_issuewild_count', 'caa_iodef_count',
  'caa_unknown_tag_count', 'caa_critical_count',
  'caa_issue_values', 'caa_issuewild_values', 'caa_iodef_values',
  'caa_tags_present',
]);

function assertSchema(result) {
  const keys = new Set(Object.keys(result));
  for (const k of EXPECTED_KEYS) assert.ok(keys.has(k), `Missing key: ${k}`);
  for (const k of keys) assert.ok(EXPECTED_KEYS.has(k), `Unexpected key: ${k}`);
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeDns(records = [], errorCode = null) {
  return {
    async resolveCaa() {
      if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
      return records;
    },
  };
}

// ── Fixed mock CAA records (Node.js dns.resolveCaa() format) ─────────────────

const CAA_ISSUE_LE         = { critical: 0,   issue:      'letsencrypt.org' };
const CAA_ISSUE_DIGICERT   = { critical: 0,   issue:      'digicert.com' };
const CAA_ISSUE_SECTIGO    = { critical: 0,   issue:      'sectigo.com' };
const CAA_ISSUE_CRITICAL   = { critical: 128, issue:      'comodoca.com' };
const CAA_ISSUE_EMPTY      = { critical: 0,   issue:      '' };
const CAA_ISSUEWILD_SE     = { critical: 0,   issuewild:  'sectigo.com' };
const CAA_ISSUEWILD_CRIT   = { critical: 128, issuewild:  'digicert.com' };
const CAA_IODEF_MAILTO     = { critical: 0,   iodef:      'mailto:security@example.com' };
const CAA_IODEF_HTTPS      = { critical: 0,   iodef:      'https://caa.example.com/report' };
const CAA_UNKNOWN          = { critical: 0,   accounturi: 'https://account.example.com' };
const CAA_FLAGS_RESERVED   = { critical: 64,  issue:      'example.com' };
const CAA_WITH_PARAMS      = { critical: 0,   issue:      'letsencrypt.org; validationmethods=dns-01' };

// ── parseCaaRecord ────────────────────────────────────────────────────────────

describe('parseCaaRecord', () => {
  it('parses an issue record with flags=0', () => {
    const r = parseCaaRecord({ critical: 0, issue: 'letsencrypt.org' });
    assert.equal(r.flags, 0);
    assert.equal(r.tag,   'issue');
    assert.equal(r.value, 'letsencrypt.org');
  });

  it('parses an issuewild record', () => {
    const r = parseCaaRecord({ critical: 0, issuewild: 'sectigo.com' });
    assert.equal(r.tag,   'issuewild');
    assert.equal(r.value, 'sectigo.com');
  });

  it('parses an iodef record', () => {
    const r = parseCaaRecord({ critical: 0, iodef: 'mailto:pki@example.com' });
    assert.equal(r.tag,   'iodef');
    assert.equal(r.value, 'mailto:pki@example.com');
  });

  it('parses a record with critical flag set (flags=128)', () => {
    const r = parseCaaRecord({ critical: 128, issue: 'digicert.com' });
    assert.equal(r.flags, 128);
    assert.equal(r.tag,   'issue');
    assert.equal(r.value, 'digicert.com');
  });

  it('parses an unknown tag', () => {
    const r = parseCaaRecord({ critical: 0, accounturi: 'https://account.example.com' });
    assert.equal(r.tag,   'accounturi');
    assert.equal(r.value, 'https://account.example.com');
  });

  it('preserves empty value verbatim', () => {
    const r = parseCaaRecord({ critical: 0, issue: '' });
    assert.equal(r.tag,   'issue');
    assert.equal(r.value, '');
  });

  it('preserves non-standard flags verbatim', () => {
    const r = parseCaaRecord({ critical: 64, issue: 'example.com' });
    assert.equal(r.flags, 64);
  });

  it('returns empty tag for malformed record with no tag property', () => {
    const r = parseCaaRecord({ critical: 0 });
    assert.equal(r.tag,   '');
    assert.equal(r.value, '');
    assert.equal(r.flags, 0);
  });

  it('defaults flags to 0 when critical is not a number', () => {
    const r = parseCaaRecord({ issue: 'letsencrypt.org' });
    assert.equal(r.flags, 0);
    assert.equal(r.tag,   'issue');
  });

  it('skips Node.js type metadata field to reach the real tag', () => {
    const r = parseCaaRecord({ critical: 0, type: 'CAA', issue: 'letsencrypt.org' });
    assert.equal(r.tag,   'issue');
    assert.equal(r.value, 'letsencrypt.org');
  });

  it('skips type field for issuewild records', () => {
    const r = parseCaaRecord({ critical: 0, type: 'CAA', issuewild: 'sectigo.com' });
    assert.equal(r.tag,   'issuewild');
    assert.equal(r.value, 'sectigo.com');
  });

  it('skips type field for iodef records', () => {
    const r = parseCaaRecord({ critical: 0, type: 'CAA', iodef: 'mailto:pki@example.com' });
    assert.equal(r.tag,   'iodef');
    assert.equal(r.value, 'mailto:pki@example.com');
  });

  it('skips type field for unknown tags', () => {
    const r = parseCaaRecord({ critical: 0, type: 'CAA', issuevmc: 'digicert.com' });
    assert.equal(r.tag,   'issuevmc');
    assert.equal(r.value, 'digicert.com');
  });
});

// ── collectCaa — present ──────────────────────────────────────────────────────

describe('collectCaa — present', () => {
  it('returns dns_caa_present = true when records are returned', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.equal(r.dns_caa_present, true);
  });

  it('returns caa_collection_error = null when records are present', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.equal(r.caa_collection_error, null);
  });

  it('stores parsed record fields verbatim', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.equal(r.caa_records[0].flags, 0);
    assert.equal(r.caa_records[0].tag,   'issue');
    assert.equal(r.caa_records[0].value, 'letsencrypt.org');
  });

  it('caa_record_count matches the number of records returned', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_record_count, 3);
  });

  it('schema: all 13 expected keys present in present state', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assertSchema(r);
  });
});

// ── collectCaa — absent ───────────────────────────────────────────────────────

describe('collectCaa — absent', () => {
  it('returns dns_caa_present = false when ENODATA thrown', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.equal(r.dns_caa_present, false);
    assert.equal(r.caa_collection_error, null);
  });

  it('returns dns_caa_present = false when ENOTFOUND thrown', async () => {
    const r = await collectCaa('no-such-domain.invalid', { dnsResolver: makeDns([], 'ENOTFOUND') });
    assert.equal(r.dns_caa_present, false);
  });

  it('returns dns_caa_present = false when empty array returned', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([]) });
    assert.equal(r.dns_caa_present, false);
  });

  it('absent result has all counts = 0', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.equal(r.caa_record_count,      0);
    assert.equal(r.caa_issue_count,       0);
    assert.equal(r.caa_issuewild_count,   0);
    assert.equal(r.caa_iodef_count,       0);
    assert.equal(r.caa_unknown_tag_count, 0);
    assert.equal(r.caa_critical_count,    0);
  });

  it('absent result has all arrays empty', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.deepEqual(r.caa_records,          []);
    assert.deepEqual(r.caa_issue_values,     []);
    assert.deepEqual(r.caa_issuewild_values, []);
    assert.deepEqual(r.caa_iodef_values,     []);
    assert.deepEqual(r.caa_tags_present,     []);
  });

  it('schema: all 13 expected keys present in absent state', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assertSchema(r);
  });
});

// ── collectCaa — error states ─────────────────────────────────────────────────

describe('collectCaa — error states', () => {
  it('returns dns_caa_present = null and DNS_TIMEOUT on ETIMEDOUT', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assert.equal(r.dns_caa_present,      null);
    assert.equal(r.caa_collection_error, 'DNS_TIMEOUT');
  });

  it('returns dns_caa_present = null and DNS_SERVFAIL on ESERVFAIL', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ESERVFAIL') });
    assert.equal(r.dns_caa_present,      null);
    assert.equal(r.caa_collection_error, 'DNS_SERVFAIL');
  });

  it('returns dns_caa_present = null and DNS_FAILURE on generic error', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ECONNREFUSED') });
    assert.equal(r.dns_caa_present,      null);
    assert.equal(r.caa_collection_error, 'DNS_FAILURE');
  });

  it('uncertain result has null caa_record_count', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assert.equal(r.caa_record_count, null);
  });

  it('uncertain result has null counts for all derived observations', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assert.equal(r.caa_issue_count,       null);
    assert.equal(r.caa_issuewild_count,   null);
    assert.equal(r.caa_iodef_count,       null);
    assert.equal(r.caa_unknown_tag_count, null);
    assert.equal(r.caa_critical_count,    null);
  });

  it('uncertain result has empty arrays (not null) for array fields', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assert.deepEqual(r.caa_records,          []);
    assert.deepEqual(r.caa_issue_values,     []);
    assert.deepEqual(r.caa_issuewild_values, []);
    assert.deepEqual(r.caa_iodef_values,     []);
    assert.deepEqual(r.caa_tags_present,     []);
  });

  it('schema: all 13 expected keys present in error state', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ETIMEDOUT') });
    assertSchema(r);
  });
});

// ── collectCaa — issue records ────────────────────────────────────────────────

describe('collectCaa — issue records', () => {
  it('single issue record: caa_issue_count = 1', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.equal(r.caa_issue_count, 1);
  });

  it('single issue record: caa_issue_values contains the value', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.deepEqual(r.caa_issue_values, ['letsencrypt.org']);
  });

  it('multiple issue records: count and values both correct', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_DIGICERT]),
    });
    assert.equal(r.caa_issue_count, 2);
    assert.deepEqual(r.caa_issue_values, ['letsencrypt.org', 'digicert.com']);
  });

  it('empty issue value preserved verbatim', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_EMPTY]) });
    assert.equal(r.caa_issue_count,      1);
    assert.deepEqual(r.caa_issue_values, ['']);
    assert.equal(r.caa_records[0].value, '');
  });

  it('issue value with parameters preserved verbatim', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_WITH_PARAMS]) });
    assert.equal(r.caa_issue_values[0], 'letsencrypt.org; validationmethods=dns-01');
    assert.equal(r.caa_records[0].value, 'letsencrypt.org; validationmethods=dns-01');
  });

  it('issue records do not affect issuewild or iodef counts', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_DIGICERT]),
    });
    assert.equal(r.caa_issuewild_count, 0);
    assert.equal(r.caa_iodef_count,     0);
  });
});

// ── collectCaa — issuewild records ────────────────────────────────────────────

describe('collectCaa — issuewild records', () => {
  it('single issuewild record: caa_issuewild_count = 1', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUEWILD_SE]) });
    assert.equal(r.caa_issuewild_count, 1);
  });

  it('issuewild value preserved in caa_issuewild_values', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUEWILD_SE]) });
    assert.deepEqual(r.caa_issuewild_values, ['sectigo.com']);
  });

  it('issuewild does not affect issue or iodef counts', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUEWILD_SE]) });
    assert.equal(r.caa_issue_count, 0);
    assert.equal(r.caa_iodef_count, 0);
  });

  it('multiple issuewild records counted correctly', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUEWILD_SE, CAA_ISSUEWILD_CRIT]),
    });
    assert.equal(r.caa_issuewild_count,     2);
    assert.equal(r.caa_issuewild_values[0], 'sectigo.com');
    assert.equal(r.caa_issuewild_values[1], 'digicert.com');
  });
});

// ── collectCaa — iodef records ────────────────────────────────────────────────

describe('collectCaa — iodef records', () => {
  it('mailto iodef: caa_iodef_count = 1', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_IODEF_MAILTO]) });
    assert.equal(r.caa_iodef_count, 1);
  });

  it('mailto iodef value preserved verbatim', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_IODEF_MAILTO]) });
    assert.deepEqual(r.caa_iodef_values, ['mailto:security@example.com']);
  });

  it('https iodef value preserved verbatim', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_IODEF_HTTPS]) });
    assert.deepEqual(r.caa_iodef_values, ['https://caa.example.com/report']);
  });

  it('multiple iodef records: count and values correct', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_IODEF_MAILTO, CAA_IODEF_HTTPS]),
    });
    assert.equal(r.caa_iodef_count, 2);
    assert.equal(r.caa_iodef_values[0], 'mailto:security@example.com');
    assert.equal(r.caa_iodef_values[1], 'https://caa.example.com/report');
  });
});

// ── collectCaa — unknown tags ─────────────────────────────────────────────────

describe('collectCaa — unknown tags', () => {
  it('unknown tag increments caa_unknown_tag_count', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_UNKNOWN]) });
    assert.equal(r.caa_unknown_tag_count, 1);
  });

  it('unknown tag name appears in caa_tags_present', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_UNKNOWN]) });
    assert.ok(r.caa_tags_present.includes('accounturi'));
  });

  it('unknown tag value preserved verbatim in caa_records', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_UNKNOWN]) });
    assert.equal(r.caa_records[0].tag,   'accounturi');
    assert.equal(r.caa_records[0].value, 'https://account.example.com');
  });

  it('unknown tag does not affect standard tag counts', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_UNKNOWN]) });
    assert.equal(r.caa_issue_count,     0);
    assert.equal(r.caa_issuewild_count, 0);
    assert.equal(r.caa_iodef_count,     0);
  });
});

// ── collectCaa — mixed records ────────────────────────────────────────────────

describe('collectCaa — mixed records', () => {
  it('all three standard tags: counts each correct', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_issue_count,     1);
    assert.equal(r.caa_issuewild_count, 1);
    assert.equal(r.caa_iodef_count,     1);
    assert.equal(r.caa_unknown_tag_count, 0);
  });

  it('all three standard tags: caa_record_count = 3', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_record_count, 3);
  });

  it('mixed standard + unknown: unknown_tag_count = 1', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_UNKNOWN]),
    });
    assert.equal(r.caa_issue_count,       1);
    assert.equal(r.caa_unknown_tag_count, 1);
    assert.equal(r.caa_record_count,      2);
  });

  it('multiple issue + issuewild + iodef: total count correct', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_DIGICERT, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_record_count,    4);
    assert.equal(r.caa_issue_count,     2);
    assert.equal(r.caa_issuewild_count, 1);
    assert.equal(r.caa_iodef_count,     1);
  });

  it('schema valid for mixed records', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assertSchema(r);
  });
});

// ── collectCaa — flags ────────────────────────────────────────────────────────

describe('collectCaa — flags', () => {
  it('flags=0 record: not counted in caa_critical_count', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.equal(r.caa_critical_count, 0);
  });

  it('flags=128 record: counted in caa_critical_count', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_CRITICAL]) });
    assert.equal(r.caa_critical_count, 1);
  });

  it('flags=128 preserved verbatim in caa_records', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_CRITICAL]) });
    assert.equal(r.caa_records[0].flags, 128);
  });

  it('mixed critical and non-critical: caa_critical_count correct', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_CRITICAL, CAA_ISSUEWILD_CRIT, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_critical_count, 2);
  });

  it('reserved flag bits (flags=64) preserved verbatim, not counted as critical', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_FLAGS_RESERVED]) });
    assert.equal(r.caa_records[0].flags, 64);
    assert.equal(r.caa_critical_count, 0); // bit 7 (MSB, value 128) not set
  });
});

// ── collectCaa — duplicate records ───────────────────────────────────────────

describe('collectCaa — duplicate records', () => {
  it('duplicate issue records preserved, not deduplicated', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_LE]),
    });
    assert.equal(r.caa_record_count, 2);
    assert.equal(r.caa_issue_count,  2);
  });

  it('duplicate values appear twice in caa_issue_values', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_LE]),
    });
    assert.deepEqual(r.caa_issue_values, ['letsencrypt.org', 'letsencrypt.org']);
  });

  it('caa_tags_present deduplicated despite duplicate records', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_LE, CAA_ISSUE_DIGICERT]),
    });
    assert.deepEqual(r.caa_tags_present, ['issue']); // only once
  });
});

// ── collectCaa — DNS return order ─────────────────────────────────────────────

describe('collectCaa — DNS return order', () => {
  it('caa_records preserves DNS return order', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_IODEF_MAILTO, CAA_ISSUE_LE, CAA_ISSUEWILD_SE]),
    });
    assert.equal(r.caa_records[0].tag, 'iodef');
    assert.equal(r.caa_records[1].tag, 'issue');
    assert.equal(r.caa_records[2].tag, 'issuewild');
  });

  it('caa_issue_values preserves DNS return order (not sorted)', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_SECTIGO, CAA_ISSUE_LE, CAA_ISSUE_DIGICERT]),
    });
    assert.equal(r.caa_issue_values[0], 'sectigo.com');
    assert.equal(r.caa_issue_values[1], 'letsencrypt.org');
    assert.equal(r.caa_issue_values[2], 'digicert.com');
  });

  it('caa_iodef_values preserves DNS return order', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_IODEF_HTTPS, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_iodef_values[0], 'https://caa.example.com/report');
    assert.equal(r.caa_iodef_values[1], 'mailto:security@example.com');
  });
});

// ── collectCaa — evidence preservation ───────────────────────────────────────

describe('collectCaa — evidence preservation', () => {
  it('www. prefix stripped before collecting', async () => {
    let queriedName;
    const resolver = {
      async resolveCaa(name) { queriedName = name; return []; },
    };
    await collectCaa('www.example.com', { dnsResolver: resolver });
    assert.equal(queriedName, 'example.com');
  });

  it('domain lowercased and trimmed before collecting', async () => {
    let queriedName;
    const resolver = {
      async resolveCaa(name) { queriedName = name; return []; },
    };
    await collectCaa('  EXAMPLE.COM  ', { dnsResolver: resolver });
    assert.equal(queriedName, 'example.com');
  });

  it('caa_records length matches caa_record_count', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO]),
    });
    assert.equal(r.caa_records.length, r.caa_record_count);
  });

  it('value in caa_records matches corresponding value array entry', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_DIGICERT]),
    });
    assert.equal(r.caa_records[0].value, r.caa_issue_values[0]);
    assert.equal(r.caa_records[1].value, r.caa_issue_values[1]);
  });
});

// ── collectCaa — caa_tags_present ────────────────────────────────────────────

describe('collectCaa — caa_tags_present', () => {
  it('single issue record: caa_tags_present = ["issue"]', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([CAA_ISSUE_LE]) });
    assert.deepEqual(r.caa_tags_present, ['issue']);
  });

  it('sorted alphabetically: iodef before issue before issuewild', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO, CAA_ISSUE_LE]),
    });
    assert.deepEqual(r.caa_tags_present, ['iodef', 'issue', 'issuewild']);
  });

  it('deduplicated despite multiple records of same tag', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_ISSUE_DIGICERT, CAA_ISSUE_SECTIGO]),
    });
    assert.deepEqual(r.caa_tags_present, ['issue']);
  });

  it('includes unknown tag names alongside standard tags', async () => {
    const r = await collectCaa('example.com', {
      dnsResolver: makeDns([CAA_ISSUE_LE, CAA_UNKNOWN]),
    });
    assert.ok(r.caa_tags_present.includes('issue'));
    assert.ok(r.caa_tags_present.includes('accounturi'));
  });

  it('empty when no records (absent state)', async () => {
    const r = await collectCaa('example.com', { dnsResolver: makeDns([], 'ENODATA') });
    assert.deepEqual(r.caa_tags_present, []);
  });
});

// ── Schema consistency ────────────────────────────────────────────────────────

describe('schema consistency', () => {
  const SCENARIOS = [
    { name: 'present, single issue',       records: [CAA_ISSUE_LE] },
    { name: 'present, issue + issuewild',  records: [CAA_ISSUE_LE, CAA_ISSUEWILD_SE] },
    { name: 'present, all three tags',     records: [CAA_ISSUE_LE, CAA_ISSUEWILD_SE, CAA_IODEF_MAILTO] },
    { name: 'present, unknown tag',        records: [CAA_UNKNOWN] },
    { name: 'present, critical flag',      records: [CAA_ISSUE_CRITICAL] },
    { name: 'present, empty value',        records: [CAA_ISSUE_EMPTY] },
    { name: 'present, multiple issues',    records: [CAA_ISSUE_LE, CAA_ISSUE_DIGICERT] },
    { name: 'present, duplicate record',   records: [CAA_ISSUE_LE, CAA_ISSUE_LE] },
    { name: 'absent (empty array)',        records: [] },
    { name: 'absent (ENODATA)',            error:   'ENODATA' },
    { name: 'absent (ENOTFOUND)',          error:   'ENOTFOUND' },
    { name: 'unknown (ETIMEDOUT)',         error:   'ETIMEDOUT' },
    { name: 'unknown (ESERVFAIL)',         error:   'ESERVFAIL' },
    { name: 'unknown (other)',             error:   'ECONNREFUSED' },
  ];

  for (const s of SCENARIOS) {
    it(`identical key set for: ${s.name}`, async () => {
      const r = await collectCaa('example.com', {
        dnsResolver: makeDns(s.records ?? [], s.error ?? null),
      });
      assertSchema(r);
    });
  }

  it('caa_records is always an array in all states', async () => {
    for (const s of SCENARIOS) {
      const r = await collectCaa('example.com', {
        dnsResolver: makeDns(s.records ?? [], s.error ?? null),
      });
      assert.ok(Array.isArray(r.caa_records), `caa_records not array for: ${s.name}`);
    }
  });

  it('caa_issue_values is always an array in all states', async () => {
    for (const s of SCENARIOS) {
      const r = await collectCaa('example.com', {
        dnsResolver: makeDns(s.records ?? [], s.error ?? null),
      });
      assert.ok(Array.isArray(r.caa_issue_values), `caa_issue_values not array for: ${s.name}`);
    }
  });

  it('caa_tags_present is always an array in all states', async () => {
    for (const s of SCENARIOS) {
      const r = await collectCaa('example.com', {
        dnsResolver: makeDns(s.records ?? [], s.error ?? null),
      });
      assert.ok(Array.isArray(r.caa_tags_present), `caa_tags_present not array for: ${s.name}`);
    }
  });
});
