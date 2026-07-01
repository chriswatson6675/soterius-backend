'use strict';

// SOT-MTASTS-001 — MTA-STS Collector Unit Tests
//
// 12 suites covering:
//   parseStsRecord       — DNS record parsing
//   parsePolicyBody      — policy file parsing
//   collectMtaSts DNS    — present / absent / unknown / multiple records
//   collectMtaSts HTTPS  — 200 / 4xx / 5xx / redirects / fetch failures
//   collectMtaSts TLS    — all five TLS scenarios + two-pass behaviour
//   Output schema        — consistent keys across all states

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectMtaSts,
  parseStsRecord,
  parsePolicyBody,
  classifyFetchError,
  SIGNAL_ID,
  SIGNAL_VERSION,
} = require('./mtasts-collector');

// ── Mock helpers ───────────────────────────────────────────────────────────────

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

// makeHttpFetcher: each element of `responses` maps to one call (Pass 1 = [0], Pass 2 = [1])
// { throws: { code, message } } or { status, body, contentType, redirectCount }
function makeHttpFetcher(responses) {
  let idx = 0;
  return async (_url, _opts) => {
    const r = responses[idx++];
    if (!r) throw Object.assign(new Error('No more mock responses'), { code: 'ECONNREFUSED' });
    if (r.throws) throw Object.assign(new Error(r.throws.message ?? r.throws.code), { code: r.throws.code });
    return {
      httpStatus:   r.status,
      body:         r.body ?? null,
      contentType:  r.contentType ?? 'text/plain',
      redirectCount: r.redirectCount ?? 0,
    };
  };
}

// A no-op fetcher that should never be called (used when we expect HTTPS to be skipped)
function neverCalledFetcher() {
  return async () => { throw new Error('httpFetcher should not have been called'); };
}

// ── Known good data ────────────────────────────────────────────────────────────

const DNS = {
  valid:         'v=STSv1; id=20241201000000Z',
  validWithId:   'v=STSv1; id=abc123',
  noId:          'v=STSv1',
  unknownTag:    'v=STSv1; id=test; x-custom=hello',
  wrongVersion:  'v=STSv2; id=test',
  malformed:     'v=STSv1; badtag; id=test',
  duplicate:     'v=STSv1; id=first; id=second',
};

const POLICY = {
  enforce: `version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: 604800`,
  testing: `version: STSv1\nmode: testing\nmx: mail.example.com\nmx: *.backup.example.com\nmax_age: 86400`,
  none:    `version: STSv1\nmode: none\nmax_age: 0`,
  full:    `version: STSv1\nmode: enforce\nmx: mail.example.com\nmx: *.example.net\nmax_age: 604800\nx-custom: value`,
  crlf:    `version: STSv1\r\nmode: enforce\r\nmx: mail.example.com\r\nmax_age: 604800`,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 1: parseStsRecord — valid records
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseStsRecord — valid records', () => {
  it('parses minimal valid record', () => {
    const r = parseStsRecord(DNS.valid);
    assert.equal(r.parse_success, true);
    assert.equal(r.dns_version, 'STSv1');
    assert.equal(r.dns_id, '20241201000000Z');
    assert.deepEqual(r.dns_unknown_tags, {});
    assert.equal(r.syntax_errors.length, 0);
  });

  it('parses id= value exactly as observed', () => {
    const r = parseStsRecord(DNS.validWithId);
    assert.equal(r.dns_id, 'abc123');
  });

  it('preserves unknown tags', () => {
    const r = parseStsRecord(DNS.unknownTag);
    assert.equal(r.parse_success, true);
    assert.deepEqual(r.dns_unknown_tags, { 'x-custom': 'hello' });
  });

  it('unknown tags do not trigger parse failure', () => {
    const r = parseStsRecord(DNS.unknownTag);
    assert.equal(r.parse_success, true);
    assert.equal(r.syntax_errors.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 2: parseStsRecord — syntax errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseStsRecord — syntax errors', () => {
  it('EMPTY_RECORD for empty string', () => {
    const r = parseStsRecord('');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_RECORD'));
  });

  it('MISSING_VERSION when v= absent', () => {
    const r = parseStsRecord('id=test');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_VERSION'));
  });

  it('INVALID_VERSION when v=STSv2', () => {
    const r = parseStsRecord(DNS.wrongVersion);
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_VERSION'));
    assert.equal(r.dns_version, 'STSv2');
  });

  it('MISSING_ID when id= absent', () => {
    const r = parseStsRecord(DNS.noId);
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_ID'));
    assert.equal(r.dns_id, null);
  });

  it('MALFORMED_TAG for tag without = sign', () => {
    const r = parseStsRecord(DNS.malformed);
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_TAG'));
  });

  it('DUPLICATE_TAG for repeated id=', () => {
    const r = parseStsRecord(DNS.duplicate);
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'DUPLICATE_TAG'));
    assert.equal(r.dns_id, 'first');  // first occurrence used
  });

  it('collects multiple errors in a single pass', () => {
    const r = parseStsRecord('v=STSv2; badtag');
    assert.equal(r.parse_success, false);
    const codes = r.syntax_errors.map(e => e.code);
    assert.ok(codes.includes('INVALID_VERSION'));
    assert.ok(codes.includes('MALFORMED_TAG'));
    assert.ok(codes.includes('MISSING_ID'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 3: parsePolicyBody — valid bodies
// ═══════════════════════════════════════════════════════════════════════════════

describe('parsePolicyBody — valid bodies', () => {
  it('parses enforce policy', () => {
    const r = parsePolicyBody(POLICY.enforce);
    assert.equal(r.parse_success, true);
    assert.equal(r.policy_version, 'STSv1');
    assert.equal(r.policy_mode, 'enforce');
    assert.equal(r.policy_max_age, 604800);
    assert.deepEqual(r.policy_mx_patterns, ['mail.example.com']);
    assert.equal(r.policy_mx_count, 1);
    assert.equal(r.syntax_errors.length, 0);
  });

  it('parses testing policy with multiple mx entries', () => {
    const r = parsePolicyBody(POLICY.testing);
    assert.equal(r.policy_mode, 'testing');
    assert.deepEqual(r.policy_mx_patterns, ['mail.example.com', '*.backup.example.com']);
    assert.equal(r.policy_mx_count, 2);
  });

  it('parses none policy with max_age=0 and no mx entries', () => {
    const r = parsePolicyBody(POLICY.none);
    assert.equal(r.parse_success, true);
    assert.equal(r.policy_mode, 'none');
    assert.equal(r.policy_max_age, 0);
    assert.deepEqual(r.policy_mx_patterns, []);
  });

  it('preserves unknown fields', () => {
    const r = parsePolicyBody(POLICY.full);
    assert.equal(r.parse_success, true);
    assert.deepEqual(r.policy_unknown_fields, { 'x-custom': 'value' });
  });

  it('handles CRLF line endings', () => {
    const r = parsePolicyBody(POLICY.crlf);
    assert.equal(r.parse_success, true);
    assert.equal(r.policy_mode, 'enforce');
  });

  it('mx entries are preserved in document order', () => {
    const body = `version: STSv1\nmode: enforce\nmx: first.example.com\nmx: second.example.com\nmx: third.example.com\nmax_age: 300`;
    const r = parsePolicyBody(body);
    assert.deepEqual(r.policy_mx_patterns, ['first.example.com', 'second.example.com', 'third.example.com']);
  });

  it('absent fields return null (not RFC defaults)', () => {
    const r = parsePolicyBody(POLICY.none);
    // mode=none has no mx requirement; policy_mx_patterns is empty not null
    assert.deepEqual(r.policy_mx_patterns, []);
    assert.deepEqual(r.policy_unknown_fields, {});
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 4: parsePolicyBody — syntax errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('parsePolicyBody — syntax errors', () => {
  it('EMPTY_BODY for empty string', () => {
    const r = parsePolicyBody('');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'EMPTY_BODY'));
  });

  it('MISSING_VERSION when version field absent', () => {
    const r = parsePolicyBody('mode: enforce\nmx: mail.example.com\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_VERSION'));
  });

  it('INVALID_VERSION when version: STSv2', () => {
    const r = parsePolicyBody('version: STSv2\nmode: enforce\nmx: mail.example.com\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_VERSION'));
    assert.equal(r.policy_version, 'STSv2');  // stored as observed
  });

  it('MISSING_MODE when mode field absent', () => {
    const r = parsePolicyBody('version: STSv1\nmx: mail.example.com\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_MODE'));
  });

  it('INVALID_MODE when mode: strict', () => {
    const r = parsePolicyBody('version: STSv1\nmode: strict\nmx: mail.example.com\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_MODE'));
    assert.equal(r.policy_mode, null);
  });

  it('MISSING_MAX_AGE when max_age field absent', () => {
    const r = parsePolicyBody('version: STSv1\nmode: enforce\nmx: mail.example.com');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MISSING_MAX_AGE'));
  });

  it('INVALID_MAX_AGE when max_age is non-numeric', () => {
    const r = parsePolicyBody('version: STSv1\nmode: enforce\nmx: mail.example.com\nmax_age: forever');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'INVALID_MAX_AGE'));
    assert.equal(r.policy_max_age, null);
  });

  it('MALFORMED_LINE for line without colon', () => {
    const r = parsePolicyBody('version: STSv1\nmode: enforce\nthishasnocolon\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'MALFORMED_LINE'));
  });

  it('DUPLICATE_FIELD for repeated mode', () => {
    const r = parsePolicyBody('version: STSv1\nmode: enforce\nmode: testing\nmx: mail.example.com\nmax_age: 300');
    assert.equal(r.parse_success, false);
    assert.ok(r.syntax_errors.some(e => e.code === 'DUPLICATE_FIELD'));
    assert.equal(r.policy_mode, 'enforce');  // first occurrence used
  });

  it('collects multiple errors in a single parse', () => {
    const r = parsePolicyBody('mode: strict\nmax_age: abc');
    const codes = r.syntax_errors.map(e => e.code);
    assert.ok(codes.includes('MISSING_VERSION'));
    assert.ok(codes.includes('INVALID_MODE'));
    assert.ok(codes.includes('INVALID_MAX_AGE'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 5: collectMtaSts — DNS present
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — DNS present', () => {
  const fetcher = makeHttpFetcher([{ status: 200, body: POLICY.enforce }]);

  it('returns dns_sts_present=true when v=STSv1 record exists', async () => {
    const dnsR = makeDns([DNS.valid]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_sts_present, true);
    assert.equal(r.dns_collection_error, null);
    assert.equal(r.dns_record_count, 1);
    assert.equal(r.dns_sts_record_count, 1);
    assert.equal(r.dns_multiple_sts_records, false);
    assert.equal(r.dns_id, '20241201000000Z');
  });

  it('strips www. before querying', async () => {
    const dnsR = makeDnsWithCapture([DNS.valid]);
    await collectMtaSts('www.example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(dnsR._calls[0], '_mta-sts.example.com');
  });

  it('queries _mta-sts.<domain>', async () => {
    const dnsR = makeDnsWithCapture([DNS.valid]);
    await collectMtaSts('university.ac.uk', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(dnsR._calls[0], '_mta-sts.university.ac.uk');
  });

  it('preserves raw record in dns_records[0]', async () => {
    const dnsR = makeDns([DNS.valid]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_records[0], DNS.valid);
  });

  it('ignores non-v=STSv1 TXT records', async () => {
    const dnsR = makeDns(['v=spf1 -all', DNS.valid, 'some-other-record']);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_record_count, 1);
    assert.equal(r.dns_records[0], DNS.valid);
  });

  it('preserves unknown DNS tags', async () => {
    const dnsR = makeDns([DNS.unknownTag]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.deepEqual(r.dns_unknown_tags, { 'x-custom': 'hello' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 6: collectMtaSts — DNS absent
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — DNS absent', () => {
  it('ENODATA -> dns_sts_present=false, no error', async () => {
    const dnsR = makeDns([], 'ENODATA');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, false);
    assert.equal(r.dns_collection_error, null);
    assert.equal(r.dns_record_count, 0);
    assert.equal(r.dns_multiple_sts_records, false);
    assert.equal(r.dns_parse_success, null);
  });

  it('ENOTFOUND -> dns_sts_present=false', async () => {
    const dnsR = makeDns([], 'ENOTFOUND');
    const r = await collectMtaSts('no-domain.invalid', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, false);
  });

  it('TXT records exist but none is v=STSv1 -> dns_sts_present=false', async () => {
    const dnsR = makeDns(['v=spf1 -all', 'google-site-verification=abc']);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, false);
    assert.equal(r.dns_records.length, 0);
  });

  it('absent state: all DNS tag fields are null', async () => {
    const dnsR = makeDns([], 'ENODATA');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_version, null);
    assert.equal(r.dns_id, null);
    assert.deepEqual(r.dns_unknown_tags, {});
    assert.deepEqual(r.dns_syntax_errors, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 7: collectMtaSts — DNS errors
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — DNS errors', () => {
  it('ETIMEDOUT -> dns_sts_present=null, DNS_TIMEOUT', async () => {
    const dnsR = makeDns([], 'ETIMEDOUT');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, null);
    assert.equal(r.dns_collection_error, 'DNS_TIMEOUT');
    assert.equal(r.dns_record_count, null);
    assert.equal(r.dns_multiple_sts_records, null);
  });

  it('ESERVFAIL -> dns_sts_present=null, DNS_SERVFAIL', async () => {
    const dnsR = makeDns([], 'ESERVFAIL');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, null);
    assert.equal(r.dns_collection_error, 'DNS_SERVFAIL');
  });

  it('ECONNREFUSED -> dns_sts_present=null, DNS_FAILURE', async () => {
    const dnsR = makeDns([], 'ECONNREFUSED');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, null);
    assert.equal(r.dns_collection_error, 'DNS_FAILURE');
  });

  it('unknown DNS error -> DNS_FAILURE', async () => {
    const dnsR = makeDns([], 'EUNKNOWN_XYZ');
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 404, body: null }]) });
    assert.equal(r.dns_sts_present, null);
    assert.equal(r.dns_collection_error, 'DNS_FAILURE');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 8: collectMtaSts — multiple DNS records
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — multiple DNS records', () => {
  const REC_A = 'v=STSv1; id=aaa';
  const REC_B = 'v=STSv1; id=bbb';

  it('both records are preserved in dns_records[]', async () => {
    const dnsR = makeDns([REC_A, REC_B]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_sts_present, true);
    assert.equal(r.dns_record_count, 2);
    assert.equal(r.dns_multiple_sts_records, true);
    assert.equal(r.dns_records[0], REC_A);
    assert.equal(r.dns_records[1], REC_B);
  });

  it('MULTIPLE_RECORDS is in dns_syntax_errors', async () => {
    const dnsR = makeDns([REC_A, REC_B]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.ok(r.dns_syntax_errors.some(e => e.code === 'MULTIPLE_RECORDS'));
  });

  it('tags parsed from dns_records[0] (first record)', async () => {
    const dnsR = makeDns([REC_A, REC_B]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_id, 'aaa');
  });

  it('non-STS TXT records excluded from count', async () => {
    const dnsR = makeDns(['v=spf1 -all', REC_A]);
    const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]) });
    assert.equal(r.dns_record_count, 1);
    assert.equal(r.dns_multiple_sts_records, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 9: collectMtaSts — HTTPS policy present (valid TLS)
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — HTTPS policy present', () => {
  const dnsR = makeDns([DNS.valid]);

  it('HTTP 200 -> policy_present=true, policy_tls_valid=true', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]),
    });
    assert.equal(r.policy_present, true);
    assert.equal(r.policy_tls_valid, true);
    assert.equal(r.policy_tls_error, null);
    assert.equal(r.policy_body_tls_validated, true);
  });

  it('parses policy fields from body', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]),
    });
    assert.equal(r.policy_version, 'STSv1');
    assert.equal(r.policy_mode, 'enforce');
    assert.equal(r.policy_max_age, 604800);
    assert.deepEqual(r.policy_mx_patterns, ['mail.example.com']);
    assert.equal(r.policy_mx_count, 1);
    assert.equal(r.policy_parse_success, true);
  });

  it('records policy_body_raw verbatim', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]),
    });
    assert.equal(r.policy_body_raw, POLICY.enforce);
  });

  it('records content-type header', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce, contentType: 'text/plain; charset=utf-8' }]),
    });
    assert.equal(r.policy_content_type, 'text/plain; charset=utf-8');
  });

  it('records redirect count', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce, redirectCount: 2 }]),
    });
    assert.equal(r.policy_redirect_count, 2);
  });

  it('policy_fetch_attempted=true', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]),
    });
    assert.equal(r.policy_fetch_attempted, true);
  });

  it('preserves unknown policy fields', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.full }]),
    });
    assert.deepEqual(r.policy_unknown_fields, { 'x-custom': 'value' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 10: collectMtaSts — HTTPS policy absent or fetch failures
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — HTTPS policy absent or fetch failures', () => {
  const dnsR = makeDns([DNS.valid]);

  it('HTTP 404 -> policy_present=false, no parse attempted', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 404, body: '<html>not found</html>' }]),
    });
    assert.equal(r.policy_present, false);
    assert.equal(r.policy_tls_valid, true);
    assert.equal(r.policy_parse_success, null);
    assert.equal(r.policy_http_status, 404);
  });

  it('HTTP 500 -> policy_present=false', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ status: 500, body: 'Internal Server Error' }]),
    });
    assert.equal(r.policy_present, false);
    assert.equal(r.policy_http_status, 500);
  });

  it('CONNECTION_TIMEOUT -> policy_present=null, fetch error set', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ETIMEDOUT', message: 'timeout' } }]),
    });
    assert.equal(r.policy_present, null);
    assert.equal(r.policy_fetch_error, 'CONNECTION_TIMEOUT');
    assert.equal(r.policy_tls_valid, null);
    assert.equal(r.policy_http_status, null);
  });

  it('ECONNREFUSED -> policy_present=null, CONNECTION_REFUSED', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ECONNREFUSED', message: 'refused' } }]),
    });
    assert.equal(r.policy_present, null);
    assert.equal(r.policy_fetch_error, 'CONNECTION_REFUSED');
    assert.equal(r.policy_tls_valid, null);
  });

  it('ENOTFOUND -> policy_present=null, DNS_ERROR', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ENOTFOUND', message: 'not found' } }]),
    });
    assert.equal(r.policy_present, null);
    assert.equal(r.policy_fetch_error, 'DNS_ERROR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 11: collectMtaSts — TLS failure scenarios
// ═══════════════════════════════════════════════════════════════════════════════

describe('collectMtaSts — TLS failure scenarios', () => {
  const dnsR = makeDns([DNS.valid]);

  // ── Category A: certificate validation failures ──────────────────────────

  it('CERT_EXPIRED: Pass 1 fails, Pass 2 retrieves policy', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'certificate expired' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'CERT_EXPIRED');
    assert.equal(r.policy_present, true);
    assert.equal(r.policy_body_tls_validated, false);
    assert.equal(r.policy_mode, 'enforce');
  });

  it('CERT_HOSTNAME_MISMATCH: Pass 1 fails, Pass 2 retrieves policy', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'hostname mismatch' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'CERT_HOSTNAME_MISMATCH');
    assert.equal(r.policy_present, true);
    assert.equal(r.policy_body_tls_validated, false);
  });

  it('CERT_SELF_SIGNED (DEPTH_ZERO): Pass 1 fails, Pass 2 retrieves policy', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.equal(r.policy_tls_error, 'CERT_SELF_SIGNED');
    assert.equal(r.policy_present, true);
  });

  it('CERT_SELF_SIGNED (SELF_SIGNED_CERT_IN_CHAIN): Pass 1 fails, Pass 2 retrieves policy', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed chain' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.equal(r.policy_tls_error, 'CERT_SELF_SIGNED');
    assert.equal(r.policy_present, true);
  });

  it('CERT_UNTRUSTED: Pass 1 fails, Pass 2 retrieves policy', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', message: 'untrusted' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.equal(r.policy_tls_error, 'CERT_UNTRUSTED');
    assert.equal(r.policy_present, true);
  });

  // ── Category B: handshake failure ────────────────────────────────────────

  it('TLS_HANDSHAKE_FAILURE (EPROTO): no Pass 2, policy_present=null', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'EPROTO', message: 'protocol error' } },
        // Pass 2 must NOT be called — if it is, makeHttpFetcher throws 'No more mock responses'
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'TLS_HANDSHAKE_FAILURE');
    assert.equal(r.policy_present, null);
    assert.equal(r.policy_body_raw, null);
  });

  it('TLS_HANDSHAKE_FAILURE (ERR_SSL_*): no Pass 2, policy_present=null', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', message: 'ssl error' } },
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'TLS_HANDSHAKE_FAILURE');
    assert.equal(r.policy_present, null);
  });

  // ── Key evidence preservation property ────────────────────────────────────

  it('Pass 1 TLS observations not overwritten when Pass 2 succeeds', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    // Must remain FALSE from Pass 1 even though Pass 2 returned HTTP 200
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'CERT_EXPIRED');
  });

  it('Pass 1 TLS observations not overwritten when Pass 2 fails', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { throws: { code: 'ECONNREFUSED', message: 'refused' } },
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'CERT_EXPIRED');
    // Pass 2 failure recorded as fetch error
    assert.equal(r.policy_fetch_error, 'CONNECTION_REFUSED');
    assert.equal(r.policy_present, null);
  });

  it('CERT_EXPIRED + Pass 2 policy 404: policy_present=false', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: dnsR,
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { status: 404, body: null },
      ]),
    });
    assert.equal(r.policy_tls_valid, false);
    assert.equal(r.policy_tls_error, 'CERT_EXPIRED');
    assert.equal(r.policy_present, false);
    assert.equal(r.policy_http_status, 404);
    assert.equal(r.policy_body_tls_validated, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 12: classifyFetchError
// ═══════════════════════════════════════════════════════════════════════════════

describe('classifyFetchError', () => {
  function err(code) { return Object.assign(new Error(code), { code }); }

  it('CERT_HAS_EXPIRED -> tls_category_a, CERT_EXPIRED', () => {
    const r = classifyFetchError(err('CERT_HAS_EXPIRED'));
    assert.equal(r.kind, 'tls_category_a');
    assert.equal(r.tlsError, 'CERT_EXPIRED');
  });

  it('ERR_TLS_CERT_ALTNAME_INVALID -> tls_category_a, CERT_HOSTNAME_MISMATCH', () => {
    const r = classifyFetchError(err('ERR_TLS_CERT_ALTNAME_INVALID'));
    assert.equal(r.kind, 'tls_category_a');
    assert.equal(r.tlsError, 'CERT_HOSTNAME_MISMATCH');
  });

  it('DEPTH_ZERO_SELF_SIGNED_CERT -> tls_category_a, CERT_SELF_SIGNED', () => {
    const r = classifyFetchError(err('DEPTH_ZERO_SELF_SIGNED_CERT'));
    assert.equal(r.kind, 'tls_category_a');
    assert.equal(r.tlsError, 'CERT_SELF_SIGNED');
  });

  it('UNABLE_TO_VERIFY_LEAF_SIGNATURE -> tls_category_a, CERT_UNTRUSTED', () => {
    const r = classifyFetchError(err('UNABLE_TO_VERIFY_LEAF_SIGNATURE'));
    assert.equal(r.kind, 'tls_category_a');
    assert.equal(r.tlsError, 'CERT_UNTRUSTED');
  });

  it('EPROTO -> tls_category_b, TLS_HANDSHAKE_FAILURE', () => {
    const r = classifyFetchError(err('EPROTO'));
    assert.equal(r.kind, 'tls_category_b');
    assert.equal(r.tlsError, 'TLS_HANDSHAKE_FAILURE');
  });

  it('ERR_SSL_* -> tls_category_b, TLS_HANDSHAKE_FAILURE', () => {
    const r = classifyFetchError(err('ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'));
    assert.equal(r.kind, 'tls_category_b');
    assert.equal(r.tlsError, 'TLS_HANDSHAKE_FAILURE');
  });

  it('ECONNREFUSED -> fetch_error, CONNECTION_REFUSED', () => {
    const r = classifyFetchError(err('ECONNREFUSED'));
    assert.equal(r.kind, 'fetch_error');
    assert.equal(r.fetchError, 'CONNECTION_REFUSED');
  });

  it('ENOTFOUND -> fetch_error, DNS_ERROR', () => {
    const r = classifyFetchError(err('ENOTFOUND'));
    assert.equal(r.kind, 'fetch_error');
    assert.equal(r.fetchError, 'DNS_ERROR');
  });

  it('ETIMEDOUT -> fetch_error, CONNECTION_TIMEOUT', () => {
    const r = classifyFetchError(err('ETIMEDOUT'));
    assert.equal(r.kind, 'fetch_error');
    assert.equal(r.fetchError, 'CONNECTION_TIMEOUT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Suite 13: Output schema consistency
// ═══════════════════════════════════════════════════════════════════════════════

const EXPECTED_KEYS = new Set([
  // DNS
  'dns_sts_present', 'dns_collection_error', 'dns_records',
  'dns_record_count', 'dns_sts_record_count', 'dns_multiple_sts_records',
  'dns_parse_success', 'dns_syntax_errors', 'dns_version', 'dns_id', 'dns_unknown_tags',
  // HTTPS
  'policy_fetch_attempted', 'policy_present', 'policy_fetch_error',
  'policy_http_status', 'policy_tls_valid', 'policy_tls_error',
  'policy_redirect_count', 'policy_content_type', 'policy_body_raw',
  'policy_body_tls_validated', 'policy_parse_success', 'policy_syntax_errors',
  'policy_version', 'policy_mode', 'policy_max_age',
  'policy_mx_patterns', 'policy_mx_count', 'policy_unknown_fields',
]);

describe('Output schema — consistent keys across all states', () => {
  it('present DNS + present policy has all 28 expected keys', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: makeDns([DNS.valid]),
      httpFetcher: makeHttpFetcher([{ status: 200, body: POLICY.enforce }]),
    });
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('absent DNS + absent policy has all 28 expected keys', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: makeDns([], 'ENODATA'),
      httpFetcher: makeHttpFetcher([{ status: 404, body: null }]),
    });
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('unknown DNS + policy fetch failure has all 28 expected keys', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: makeDns([], 'ETIMEDOUT'),
      httpFetcher: makeHttpFetcher([{ throws: { code: 'ECONNREFUSED', message: 'refused' } }]),
    });
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('TLS handshake failure has all 28 expected keys', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: makeDns([DNS.valid]),
      httpFetcher: makeHttpFetcher([{ throws: { code: 'EPROTO', message: 'proto' } }]),
    });
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('Category A TLS + Pass 2 success has all 28 expected keys', async () => {
    const r = await collectMtaSts('example.com', {
      dnsResolver: makeDns([DNS.valid]),
      httpFetcher: makeHttpFetcher([
        { throws: { code: 'CERT_HAS_EXPIRED', message: 'expired' } },
        { status: 200, body: POLICY.enforce },
      ]),
    });
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('dns_syntax_errors is always an array', async () => {
    for (const [dnsR, fetcher] of [
      [makeDns([DNS.valid]),   makeHttpFetcher([{ status: 200, body: POLICY.enforce }])],
      [makeDns([], 'ENODATA'), makeHttpFetcher([{ status: 404, body: null }])],
      [makeDns([], 'ETIMEDOUT'), makeHttpFetcher([{ status: 404, body: null }])],
    ]) {
      const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: fetcher });
      assert.ok(Array.isArray(r.dns_syntax_errors));
    }
  });

  it('policy_syntax_errors is always an array', async () => {
    for (const [dnsR, fetcher] of [
      [makeDns([DNS.valid]),   makeHttpFetcher([{ status: 200, body: POLICY.enforce }])],
      [makeDns([], 'ENODATA'), makeHttpFetcher([{ status: 404, body: null }])],
      [makeDns([DNS.valid]),   makeHttpFetcher([{ throws: { code: 'EPROTO', message: 'p' } }])],
    ]) {
      const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: fetcher });
      assert.ok(Array.isArray(r.policy_syntax_errors));
    }
  });

  it('dns_records is always an array', async () => {
    for (const [dnsR, fetcher] of [
      [makeDns([DNS.valid]),   makeHttpFetcher([{ status: 200, body: POLICY.enforce }])],
      [makeDns([], 'ENODATA'), makeHttpFetcher([{ status: 404, body: null }])],
      [makeDns([], 'ETIMEDOUT'), makeHttpFetcher([{ status: 404, body: null }])],
    ]) {
      const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: fetcher });
      assert.ok(Array.isArray(r.dns_records));
    }
  });

  it('policy_mx_patterns is always an array', async () => {
    for (const [dnsR, fetcher] of [
      [makeDns([DNS.valid]),   makeHttpFetcher([{ status: 200, body: POLICY.enforce }])],
      [makeDns([], 'ENODATA'), makeHttpFetcher([{ status: 404, body: null }])],
      [makeDns([DNS.valid]),   makeHttpFetcher([{ throws: { code: 'EPROTO', message: 'p' } }])],
    ]) {
      const r = await collectMtaSts('example.com', { dnsResolver: dnsR, httpFetcher: fetcher });
      assert.ok(Array.isArray(r.policy_mx_patterns));
    }
  });

  it('module exports SIGNAL_ID=mta-sts and SIGNAL_VERSION=1', () => {
    assert.equal(SIGNAL_ID, 'mta-sts');
    assert.equal(SIGNAL_VERSION, 1);
  });
});
