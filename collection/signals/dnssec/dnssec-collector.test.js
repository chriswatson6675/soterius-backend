'use strict';

// SOT-DNSSEC-001 — Collector Test Suite
//
// Tests use injectable mock resolvers exclusively.
// No live DNS queries are made in this suite.
//
// Usage:  node --test backend/signal-lab/signals/dnssec/dnssec-collector.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectDnssec,
  parseDsRecord,
  parseDnskeyRecord,
  computeKeyTag,
} = require('./dnssec-collector');

// ── Schema ────────────────────────────────────────────────────────────────────

const EXPECTED_KEYS = new Set([
  'dns_ds_present', 'ds_collection_error', 'ds_records', 'ds_record_count',
  'ds_algorithms', 'ds_digest_types', 'ds_key_tags',
  'dns_dnskey_present', 'dnskey_collection_error', 'dnskey_records', 'dnskey_record_count',
  'dnskey_ksk_count', 'dnskey_zsk_count', 'dnskey_other_flags_count',
  'dnskey_algorithms', 'dnskey_key_tags',
]);

function assertSchema(result) {
  const keys = new Set(Object.keys(result));
  for (const k of EXPECTED_KEYS) assert.ok(keys.has(k), `Missing key: ${k}`);
  for (const k of keys) assert.ok(EXPECTED_KEYS.has(k), `Unexpected key: ${k}`);
}

// ── Key tag test vectors ───────────────────────────────────────────────────────
//
// Vector A: flags=257, protocol=3, algorithm=13, public_key="YWJj" (base64 for [0x61,0x62,0x63])
// Wire bytes: [0x01,0x01,0x03,0x0D,0x61,0x62,0x63]
// ac = 256+1+768+13+24832+98+25344 = 51312 → key tag = 51312
//
// Vector B: flags=256, protocol=3, algorithm=1 (RSA/MD5 special case)
// public_key = base64([0xAA,0xBB,0xCC,0xDD,0xEE]) = "qrvM3g=="
// algorithm-1 key tag = (pubKeyBytes[len-3] << 8) | pubKeyBytes[len-2]
//                     = (0xCC << 8) | 0xDD = 52445

const VECTOR_A_KEY    = 'YWJj';
const VECTOR_A_KEYTAG = 51312;

const VECTOR_B_KEY    = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]).toString('base64');
const VECTOR_B_KEYTAG = (0xCC << 8) | 0xDD; // 52445

// ── Mock helpers ──────────────────────────────────────────────────────────────

function doaResponse(answers = []) {
  return { Status: 0, Answer: answers };
}

function nxdomainResponse() {
  return { Status: 3, Answer: [] };
}

function servfailResponse() {
  return { Status: 2, Answer: [] };
}

function unknownStatusResponse() {
  return { Status: 9, Answer: [] };
}

function makeError(code) {
  const e = new Error(code);
  e.code  = code;
  return e;
}

function dsAnswer(keyTag, algorithm, digestType, digest) {
  return { type: 43, data: `${keyTag} ${algorithm} ${digestType} ${digest}` };
}

function dnskeyAnswer(flags, protocol, algorithm, publicKey) {
  return { type: 48, data: `${flags} ${protocol} ${algorithm} ${publicKey}` };
}

function makeMockResolver({ dsResponse, dnskeyResponse }) {
  return {
    async queryDS()     { return dsResponse; },
    async queryDNSKEY() { return dnskeyResponse; },
  };
}

function makeThrowingResolver({ dsError, dnskeyError }) {
  return {
    async queryDS()     {
      if (dsError)     { throw makeError(dsError); }
      return doaResponse();
    },
    async queryDNSKEY() {
      if (dnskeyError) { throw makeError(dnskeyError); }
      return doaResponse();
    },
  };
}

// ── Fixed mock records ────────────────────────────────────────────────────────

const DS_RECORD_1 = dsAnswer(12345, 13, 2, 'AABBCCDD');
const DS_RECORD_2 = dsAnswer(54321,  8, 2, 'EEFF0011');
const DS_RECORD_3 = dsAnswer(11111, 13, 1, 'DEADBEEF');

const DNSKEY_KSK  = dnskeyAnswer(257, 3, 13, VECTOR_A_KEY);
const DNSKEY_ZSK  = dnskeyAnswer(256, 3, 13, VECTOR_A_KEY);
const DNSKEY_OTHER = dnskeyAnswer(385, 3, 13, VECTOR_A_KEY); // non-standard flags

// ── parseDsRecord ─────────────────────────────────────────────────────────────

describe('parseDsRecord', () => {
  it('parses a standard DS record data string', () => {
    const r = parseDsRecord('12345 13 2 AABBCCDD');
    assert.equal(r.key_tag,     12345);
    assert.equal(r.algorithm,   13);
    assert.equal(r.digest_type, 2);
    assert.equal(r.digest,      'AABBCCDD');
  });

  it('joins multi-part digest (spaces within digest field)', () => {
    const r = parseDsRecord('999 8 1 AA BB CC');
    assert.equal(r.digest, 'AABBCC');
  });

  it('preserves digest verbatim without case normalisation', () => {
    const r = parseDsRecord('1 13 2 AbCdEf');
    assert.equal(r.digest, 'AbCdEf');
  });

  it('handles leading/trailing whitespace in data string', () => {
    const r = parseDsRecord('  12345 13 2 AABB  ');
    assert.equal(r.key_tag, 12345);
    assert.equal(r.digest,  'AABB');
  });
});

// ── parseDnskeyRecord ─────────────────────────────────────────────────────────

describe('parseDnskeyRecord', () => {
  it('parses a KSK record (flags=257)', () => {
    const r = parseDnskeyRecord(`257 3 13 ${VECTOR_A_KEY}`);
    assert.equal(r.flags,      257);
    assert.equal(r.protocol,   3);
    assert.equal(r.algorithm,  13);
    assert.equal(r.public_key, VECTOR_A_KEY);
  });

  it('parses a ZSK record (flags=256)', () => {
    const r = parseDnskeyRecord(`256 3 13 ${VECTOR_A_KEY}`);
    assert.equal(r.flags,      256);
    assert.equal(r.protocol,   3);
    assert.equal(r.algorithm,  13);
    assert.equal(r.public_key, VECTOR_A_KEY);
  });

  it('joins multi-part public key (spaces within key field)', () => {
    const r = parseDnskeyRecord('257 3 13 AAAA BBBB CCCC');
    assert.equal(r.public_key, 'AAAABBBBCCCC');
  });

  it('handles leading/trailing whitespace in data string', () => {
    const r = parseDnskeyRecord(`  256 3 8 ${VECTOR_A_KEY}  `);
    assert.equal(r.flags, 256);
    assert.equal(r.algorithm, 8);
  });
});

// ── parseDsRecord — algorithm mnemonic resolution ─────────────────────────────

describe('parseDsRecord — algorithm mnemonic resolution', () => {
  it('resolves numeric algorithm string directly', () => {
    const r = parseDsRecord('12345 13 2 AABB');
    assert.equal(r.algorithm, 13);
  });

  it('resolves ECDSAP256SHA256 mnemonic to 13', () => {
    const r = parseDsRecord('12345 ECDSAP256SHA256 2 AABB');
    assert.equal(r.algorithm, 13);
  });

  it('resolves RSASHA256 mnemonic to 8', () => {
    const r = parseDsRecord('12345 RSASHA256 2 AABB');
    assert.equal(r.algorithm, 8);
  });

  it('resolves ED25519 mnemonic to 15', () => {
    const r = parseDsRecord('12345 ED25519 2 AABB');
    assert.equal(r.algorithm, 15);
  });

  it('returns null for unrecognised algorithm mnemonic', () => {
    const r = parseDsRecord('12345 UNKNOWN_ALG 2 AABB');
    assert.equal(r.algorithm, null);
  });
});

describe('parseDnskeyRecord — algorithm mnemonic resolution', () => {
  it('resolves ECDSAP256SHA256 mnemonic to 13', () => {
    const r = parseDnskeyRecord(`257 3 ECDSAP256SHA256 ${VECTOR_A_KEY}`);
    assert.equal(r.algorithm, 13);
  });

  it('returns null for unrecognised algorithm mnemonic', () => {
    const r = parseDnskeyRecord(`257 3 UNKNOWN_ALG ${VECTOR_A_KEY}`);
    assert.equal(r.algorithm, null);
  });
});

// ── computeKeyTag ─────────────────────────────────────────────────────────────

describe('computeKeyTag', () => {
  it('computes key tag for vector A (algorithm 13, known result 51312)', () => {
    const tag = computeKeyTag(257, 3, 13, VECTOR_A_KEY);
    assert.equal(tag, VECTOR_A_KEYTAG);
  });

  it('computes key tag for algorithm 1 (RSA/MD5 special case, known result 52445)', () => {
    const tag = computeKeyTag(256, 3, 1, VECTOR_B_KEY);
    assert.equal(tag, VECTOR_B_KEYTAG);
  });

  it('strips whitespace from public key before computing', () => {
    const keyWithSpaces = VECTOR_A_KEY.split('').join(' ');
    assert.equal(computeKeyTag(257, 3, 13, keyWithSpaces), VECTOR_A_KEYTAG);
  });

  it('returns 0 for algorithm 1 with fewer than 3 key bytes', () => {
    const tinyKey = Buffer.from([0xAA]).toString('base64');
    assert.equal(computeKeyTag(256, 3, 1, tinyKey), 0);
  });

  it('result is always a 16-bit integer (0–65535)', () => {
    const tag = computeKeyTag(257, 3, 13, VECTOR_A_KEY);
    assert.ok(tag >= 0 && tag <= 65535);
  });
});

// ── collectDnssec — DS present ────────────────────────────────────────────────

describe('collectDnssec — DS present', () => {
  it('returns dns_ds_present = true when DS answers are returned', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, true);
    assert.equal(r.ds_collection_error, null);
  });

  it('stores all DS record fields verbatim', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_records.length, 1);
    assert.equal(r.ds_records[0].key_tag,     12345);
    assert.equal(r.ds_records[0].algorithm,   13);
    assert.equal(r.ds_records[0].digest_type, 2);
    assert.equal(r.ds_records[0].digest,      'AABBCCDD');
  });

  it('ds_record_count matches the number of DS records', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1, DS_RECORD_2]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_record_count, 2);
  });

  it('filters out non-DS answer types (e.g. RRSIG type 46)', async () => {
    const resolver = makeMockResolver({
      dsResponse: doaResponse([
        DS_RECORD_1,
        { type: 46, data: 'some rrsig data' },
      ]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_record_count, 1);
    assert.equal(r.ds_records[0].key_tag, 12345);
  });
});

// ── collectDnssec — DS absent ─────────────────────────────────────────────────

describe('collectDnssec — DS absent', () => {
  it('returns dns_ds_present = false when Status=0 and no DS answers', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, false);
    assert.equal(r.ds_collection_error, null);
    assert.equal(r.ds_record_count, 0);
    assert.deepEqual(r.ds_records, []);
  });

  it('returns dns_ds_present = false when Status=3 (NXDOMAIN)', async () => {
    const resolver = makeMockResolver({
      dsResponse:     nxdomainResponse(),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, false);
    assert.equal(r.ds_collection_error, null);
  });

  it('non-DS answers at the query name do not constitute DS presence', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([{ type: 16, data: 'v=spf1 -all' }]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, false);
  });
});

// ── collectDnssec — DS error states ──────────────────────────────────────────

describe('collectDnssec — DS error states', () => {
  it('returns dns_ds_present = null and DNS_TIMEOUT on ECONNABORTED', async () => {
    const resolver = makeThrowingResolver({ dsError: 'ECONNABORTED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, null);
    assert.equal(r.ds_collection_error, 'DNS_TIMEOUT');
  });

  it('returns dns_ds_present = null and DNS_TIMEOUT on ETIMEDOUT', async () => {
    const resolver = makeThrowingResolver({ dsError: 'ETIMEDOUT' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, null);
    assert.equal(r.ds_collection_error, 'DNS_TIMEOUT');
  });

  it('returns dns_ds_present = null and DNS_SERVFAIL on Status=2', async () => {
    const resolver = makeMockResolver({
      dsResponse:     servfailResponse(),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, null);
    assert.equal(r.ds_collection_error, 'DNS_SERVFAIL');
  });

  it('returns dns_ds_present = null and DNS_FAILURE on generic error', async () => {
    const resolver = makeThrowingResolver({ dsError: 'ECONNREFUSED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, null);
    assert.equal(r.ds_collection_error, 'DNS_FAILURE');
  });

  it('returns dns_ds_present = null and DNS_FAILURE on unknown DoH status', async () => {
    const resolver = makeMockResolver({
      dsResponse:     unknownStatusResponse(),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_ds_present, null);
    assert.equal(r.ds_collection_error, 'DNS_FAILURE');
  });

  it('uncertain DS result has null record_count', async () => {
    const resolver = makeThrowingResolver({ dsError: 'ECONNABORTED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_record_count, null);
  });
});

// ── collectDnssec — DS multiple and duplicate records ─────────────────────────

describe('collectDnssec — DS multiple and duplicate records', () => {
  it('preserves all DS records when multiple are returned', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1, DS_RECORD_2, DS_RECORD_3]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_record_count, 3);
    assert.equal(r.ds_records[0].key_tag, 12345);
    assert.equal(r.ds_records[1].key_tag, 54321);
    assert.equal(r.ds_records[2].key_tag, 11111);
  });

  it('preserves DNS return order for DS records', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_2, DS_RECORD_1]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_records[0].key_tag, 54321);
    assert.equal(r.ds_records[1].key_tag, 12345);
  });

  it('preserves duplicate DS records without deduplication', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1, DS_RECORD_1]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.ds_record_count, 2);
    assert.equal(r.ds_records[0].key_tag, 12345);
    assert.equal(r.ds_records[1].key_tag, 12345);
  });
});

// ── collectDnssec — DS derived observations ───────────────────────────────────

describe('collectDnssec — DS derived observations', () => {
  it('ds_algorithms contains distinct algorithm values sorted numerically', async () => {
    const resolver = makeMockResolver({
      dsResponse: doaResponse([
        dsAnswer(1, 13, 2, 'AA'),
        dsAnswer(2,  8, 2, 'BB'),
        dsAnswer(3, 13, 2, 'CC'), // duplicate algorithm 13
      ]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.ds_algorithms, [8, 13]);
  });

  it('ds_digest_types contains distinct digest type values sorted numerically', async () => {
    const resolver = makeMockResolver({
      dsResponse: doaResponse([
        dsAnswer(1, 13, 2, 'AA'),
        dsAnswer(2, 13, 1, 'BB'),
        dsAnswer(3, 13, 2, 'CC'), // duplicate digest_type 2
      ]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.ds_digest_types, [1, 2]);
  });

  it('ds_key_tags preserves all key tags in DNS return order (no deduplication)', async () => {
    const resolver = makeMockResolver({
      dsResponse: doaResponse([
        dsAnswer(100, 13, 2, 'AA'),
        dsAnswer(200,  8, 2, 'BB'),
        dsAnswer(100, 13, 1, 'CC'), // duplicate key tag 100
      ]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.ds_key_tags, [100, 200, 100]);
  });

  it('unresolvable algorithm mnemonic excluded from ds_algorithms array', async () => {
    const resolver = makeMockResolver({
      dsResponse: doaResponse([
        { type: 43, data: '12345 UNKNOWN_ALG 2 AABB' },
        { type: 43, data: '54321 13 2 CCDD' },
      ]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.ds_algorithms, [13]); // UNKNOWN_ALG excluded, 13 included
    assert.equal(r.ds_record_count, 2);       // both records preserved
  });

  it('single DS record produces single-element algorithm and digest arrays', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse([DS_RECORD_1]),
      dnskeyResponse: doaResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.ds_algorithms,   [13]);
    assert.deepEqual(r.ds_digest_types, [2]);
    assert.deepEqual(r.ds_key_tags,     [12345]);
  });
});

// ── collectDnssec — DNSKEY present ────────────────────────────────────────────

describe('collectDnssec — DNSKEY present', () => {
  it('returns dns_dnskey_present = true when DNSKEY answers are returned', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, true);
    assert.equal(r.dnskey_collection_error, null);
  });

  it('stores all DNSKEY record fields verbatim', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_records[0].flags,      257);
    assert.equal(r.dnskey_records[0].protocol,   3);
    assert.equal(r.dnskey_records[0].algorithm,  13);
    assert.equal(r.dnskey_records[0].public_key, VECTOR_A_KEY);
  });

  it('preserves public key material verbatim', async () => {
    const bigKey = 'AAAA'.repeat(64); // 256-char base64
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([dnskeyAnswer(257, 3, 13, bigKey)]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_records[0].public_key, bigKey);
  });

  it('filters out non-DNSKEY answer types (e.g. RRSIG type 46)', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([
        DNSKEY_KSK,
        { type: 46, data: 'some rrsig data' },
      ]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_record_count, 1);
  });
});

// ── collectDnssec — DNSKEY absent ────────────────────────────────────────────

describe('collectDnssec — DNSKEY absent', () => {
  it('returns dns_dnskey_present = false when Status=0 and no DNSKEY answers', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, false);
    assert.equal(r.dnskey_collection_error, null);
    assert.equal(r.dnskey_record_count, 0);
    assert.deepEqual(r.dnskey_records, []);
  });

  it('returns dns_dnskey_present = false when Status=3 (NXDOMAIN)', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: nxdomainResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, false);
    assert.equal(r.dnskey_collection_error, null);
  });
});

// ── collectDnssec — DNSKEY error states ──────────────────────────────────────

describe('collectDnssec — DNSKEY error states', () => {
  it('returns dns_dnskey_present = null and DNS_TIMEOUT on ECONNABORTED', async () => {
    const resolver = makeThrowingResolver({ dnskeyError: 'ECONNABORTED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, null);
    assert.equal(r.dnskey_collection_error, 'DNS_TIMEOUT');
  });

  it('returns dns_dnskey_present = null and DNS_TIMEOUT on ETIMEDOUT', async () => {
    const resolver = makeThrowingResolver({ dnskeyError: 'ETIMEDOUT' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, null);
    assert.equal(r.dnskey_collection_error, 'DNS_TIMEOUT');
  });

  it('returns dns_dnskey_present = null and DNS_SERVFAIL on Status=2', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: servfailResponse(),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, null);
    assert.equal(r.dnskey_collection_error, 'DNS_SERVFAIL');
  });

  it('returns dns_dnskey_present = null and DNS_FAILURE on generic error', async () => {
    const resolver = makeThrowingResolver({ dnskeyError: 'ECONNREFUSED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dns_dnskey_present, null);
    assert.equal(r.dnskey_collection_error, 'DNS_FAILURE');
  });

  it('uncertain DNSKEY result has null counts', async () => {
    const resolver = makeThrowingResolver({ dnskeyError: 'ECONNABORTED' });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_record_count,      null);
    assert.equal(r.dnskey_ksk_count,         null);
    assert.equal(r.dnskey_zsk_count,         null);
    assert.equal(r.dnskey_other_flags_count, null);
  });
});

// ── collectDnssec — DNSKEY multiple records ───────────────────────────────────

describe('collectDnssec — DNSKEY multiple records', () => {
  it('preserves all DNSKEY records when multiple are returned', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_ZSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_record_count, 2);
  });

  it('preserves DNS return order for DNSKEY records', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_ZSK, DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_records[0].flags, 256);
    assert.equal(r.dnskey_records[1].flags, 257);
  });

  it('preserves duplicate DNSKEY records without deduplication', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_record_count, 2);
    assert.equal(r.dnskey_records[0].flags, 257);
    assert.equal(r.dnskey_records[1].flags, 257);
  });
});

// ── collectDnssec — DNSKEY derived observations ───────────────────────────────

describe('collectDnssec — DNSKEY derived observations', () => {
  it('counts KSK (flags=257) correctly', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_ZSK, DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_ksk_count, 2);
  });

  it('counts ZSK (flags=256) correctly', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_ZSK, DNSKEY_ZSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_zsk_count, 2);
  });

  it('counts non-standard flags correctly', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_OTHER, DNSKEY_OTHER]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.equal(r.dnskey_ksk_count,         1);
    assert.equal(r.dnskey_zsk_count,         0);
    assert.equal(r.dnskey_other_flags_count, 2);
  });

  it('dnskey_algorithms contains distinct values sorted numerically', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([
        dnskeyAnswer(257, 3, 13, VECTOR_A_KEY),
        dnskeyAnswer(256, 3,  8, VECTOR_A_KEY),
        dnskeyAnswer(257, 3, 13, VECTOR_A_KEY), // duplicate algorithm
      ]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    assert.deepEqual(r.dnskey_algorithms, [8, 13]);
  });

  it('dnskey_key_tags computed correctly for each record', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_KSK, DNSKEY_ZSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    // Both KSK and ZSK use VECTOR_A_KEY; only flags differs.
    // KSK: flags=257 (0x0101), ZSK: flags=256 (0x0100) — key tags differ.
    assert.equal(r.dnskey_key_tags.length, 2);
    assert.ok(Number.isInteger(r.dnskey_key_tags[0]));
    assert.ok(Number.isInteger(r.dnskey_key_tags[1]));
    // KSK key tag matches vector A
    assert.equal(r.dnskey_key_tags[0], VECTOR_A_KEYTAG);
  });

  it('dnskey_key_tags preserves order matching dnskey_records order', async () => {
    const resolver = makeMockResolver({
      dsResponse:     doaResponse(),
      dnskeyResponse: doaResponse([DNSKEY_ZSK, DNSKEY_KSK]),
    });
    const r = await collectDnssec('example.com', { dnsResolver: resolver });
    // First record is ZSK (flags=256), second is KSK (flags=257)
    // Both use VECTOR_A_KEY — key tags differ because flags differ
    assert.notEqual(r.dnskey_key_tags[0], r.dnskey_key_tags[1]);
  });
});

// ── collectDnssec — combined states (3×3 matrix) ─────────────────────────────

describe('collectDnssec — combined states', () => {
  async function combined(dsResponse, dnskeyResponse) {
    return collectDnssec('example.com', {
      dnsResolver: makeMockResolver({ dsResponse, dnskeyResponse }),
    });
  }

  async function combinedThrow(dsError, dnskeyError) {
    return collectDnssec('example.com', {
      dnsResolver: makeThrowingResolver({ dsError, dnskeyError }),
    });
  }

  it('DS=true, DNSKEY=true', async () => {
    const r = await combined(doaResponse([DS_RECORD_1]), doaResponse([DNSKEY_KSK]));
    assert.equal(r.dns_ds_present,     true);
    assert.equal(r.dns_dnskey_present, true);
  });

  it('DS=true, DNSKEY=false', async () => {
    const r = await combined(doaResponse([DS_RECORD_1]), doaResponse([]));
    assert.equal(r.dns_ds_present,     true);
    assert.equal(r.dns_dnskey_present, false);
  });

  it('DS=true, DNSKEY=null', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { return doaResponse([DS_RECORD_1]); },
        async queryDNSKEY() { throw makeError('ECONNABORTED'); },
      },
    });
    assert.equal(r.dns_ds_present,     true);
    assert.equal(r.dns_dnskey_present, null);
  });

  it('DS=false, DNSKEY=true', async () => {
    const r = await combined(doaResponse([]), doaResponse([DNSKEY_KSK]));
    assert.equal(r.dns_ds_present,     false);
    assert.equal(r.dns_dnskey_present, true);
  });

  it('DS=false, DNSKEY=false', async () => {
    const r = await combined(doaResponse([]), doaResponse([]));
    assert.equal(r.dns_ds_present,     false);
    assert.equal(r.dns_dnskey_present, false);
  });

  it('DS=false, DNSKEY=null', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { return doaResponse([]); },
        async queryDNSKEY() { throw makeError('ETIMEDOUT'); },
      },
    });
    assert.equal(r.dns_ds_present,     false);
    assert.equal(r.dns_dnskey_present, null);
  });

  it('DS=null, DNSKEY=true', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { throw makeError('ECONNABORTED'); },
        async queryDNSKEY() { return doaResponse([DNSKEY_KSK]); },
      },
    });
    assert.equal(r.dns_ds_present,     null);
    assert.equal(r.dns_dnskey_present, true);
  });

  it('DS=null, DNSKEY=false', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { throw makeError('ECONNABORTED'); },
        async queryDNSKEY() { return doaResponse([]); },
      },
    });
    assert.equal(r.dns_ds_present,     null);
    assert.equal(r.dns_dnskey_present, false);
  });

  it('DS=null, DNSKEY=null', async () => {
    const r = await combinedThrow('ECONNABORTED', 'ECONNABORTED');
    assert.equal(r.dns_ds_present,     null);
    assert.equal(r.dns_dnskey_present, null);
  });
});

// ── collectDnssec — evidence preservation ────────────────────────────────────

describe('collectDnssec — evidence preservation', () => {
  it('www. prefix is stripped before collecting', async () => {
    let queriedName;
    const resolver = {
      async queryDS(name)     { queriedName = name; return doaResponse(); },
      async queryDNSKEY()     { return doaResponse(); },
    };
    await collectDnssec('www.example.com', { dnsResolver: resolver });
    assert.equal(queriedName, 'example.com');
  });

  it('domain is lowercased and trimmed before collecting', async () => {
    let queriedName;
    const resolver = {
      async queryDS(name)     { queriedName = name; return doaResponse(); },
      async queryDNSKEY()     { return doaResponse(); },
    };
    await collectDnssec('  EXAMPLE.COM  ', { dnsResolver: resolver });
    assert.equal(queriedName, 'example.com');
  });

  it('DS query failure does not affect DNSKEY result', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { throw makeError('ECONNABORTED'); },
        async queryDNSKEY() { return doaResponse([DNSKEY_KSK]); },
      },
    });
    assert.equal(r.dns_ds_present,          null);
    assert.equal(r.ds_collection_error,     'DNS_TIMEOUT');
    assert.equal(r.dns_dnskey_present,      true);
    assert.equal(r.dnskey_collection_error, null);
  });

  it('DNSKEY query failure does not affect DS result', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { return doaResponse([DS_RECORD_1]); },
        async queryDNSKEY() { throw makeError('ECONNABORTED'); },
      },
    });
    assert.equal(r.dns_ds_present,          true);
    assert.equal(r.ds_collection_error,     null);
    assert.equal(r.dns_dnskey_present,      null);
    assert.equal(r.dnskey_collection_error, 'DNS_TIMEOUT');
  });
});

// ── Schema consistency — all 9 combined states produce identical key sets ─────

describe('schema consistency', () => {
  const STATES = [
    ['DS=true, DNSKEY=true',   doaResponse([DS_RECORD_1]), doaResponse([DNSKEY_KSK])],
    ['DS=true, DNSKEY=false',  doaResponse([DS_RECORD_1]), doaResponse([])],
    ['DS=false, DNSKEY=true',  doaResponse([]),             doaResponse([DNSKEY_KSK])],
    ['DS=false, DNSKEY=false', doaResponse([]),             doaResponse([])],
    ['DS=false, DNSKEY=null',  doaResponse([]),             servfailResponse()],
    ['DS=null, DNSKEY=true',   servfailResponse(),          doaResponse([DNSKEY_KSK])],
    ['DS=null, DNSKEY=false',  servfailResponse(),          doaResponse([])],
    ['DS=null, DNSKEY=null',   servfailResponse(),          servfailResponse()],
  ];

  for (const [label, dsResp, dnskeyResp] of STATES) {
    it(`identical key set for ${label}`, async () => {
      const r = await collectDnssec('example.com', {
        dnsResolver: makeMockResolver({ dsResponse: dsResp, dnskeyResponse: dnskeyResp }),
      });
      assertSchema(r);
    });
  }

  it('identical key set for DS=true, DNSKEY=null (throw)', async () => {
    const r = await collectDnssec('example.com', {
      dnsResolver: {
        async queryDS()     { return doaResponse([DS_RECORD_1]); },
        async queryDNSKEY() { throw makeError('ECONNABORTED'); },
      },
    });
    assertSchema(r);
  });
});
