'use strict';

// SOT-DKIM-001 unit tests
// Run: node --test backend/signal-lab/signals/dkim/dkim-collector.test.js

const { describe, it } = require('node:test');
const assert           = require('node:assert/strict');
const crypto           = require('node:crypto');

const { collectDkim, parseDkimRecord, PROBE_SELECTORS } = require('./dkim-collector');

// ── Test key material ─────────────────────────────────────────────────────────
// Generated at load time. RSA generation is slow but this is a test-only cost.

const { publicKey: _rsa2048 } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_2048_B64 = _rsa2048.export({ type: 'spki', format: 'der' }).toString('base64');

const { publicKey: _rsa1024 } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const RSA_1024_B64 = _rsa1024.export({ type: 'spki', format: 'der' }).toString('base64');

const { publicKey: _ed25519 } = crypto.generateKeyPairSync('ed25519');
const ED25519_B64 = _ed25519.export({ type: 'spki', format: 'der' }).toString('base64');

// ── DNS mock helpers ──────────────────────────────────────────────────────────
//
// found:  { [selector]: rawRecord }  — selector returns this TXT record
// errors: { [selector]: errorCode } — selector throws DNS error with this code
// Any selector not in found or errors returns ENODATA.

function makeDns(found = {}, errors = {}) {
  return {
    resolveTxt: async (qname) => {
      const selector = qname.split('._domainkey.')[0];
      if (errors[selector]) {
        throw Object.assign(new Error('DNS error'), { code: errors[selector] });
      }
      if (found[selector]) {
        return [[found[selector]]];
      }
      throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    },
  };
}

const VALID_RSA_RECORD   = `v=DKIM1; k=rsa; p=${RSA_2048_B64}`;
const VALID_ED25519_RECORD = `v=DKIM1; k=ed25519; p=${ED25519_B64}`;

// ── parseDkimRecord — valid records ───────────────────────────────────────────

describe('parseDkimRecord — valid records', () => {
  it('parses a valid RSA-2048 record', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_2048_B64}`);
    assert.equal(r.parse_success, true);
    assert.equal(r.key_type, 'rsa');
    assert.equal(r.key_bits, 2048);
    assert.equal(r.public_key_present, true);
    assert.equal(r.version, 'DKIM1');
    assert.deepEqual(r.syntax_errors, []);
  });

  it('parses a valid RSA-1024 record', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_1024_B64}`);
    assert.equal(r.parse_success, true);
    assert.equal(r.key_bits, 1024);
  });

  it('parses a valid Ed25519 record', () => {
    const r = parseDkimRecord(`v=DKIM1; k=ed25519; p=${ED25519_B64}`);
    assert.equal(r.parse_success, true);
    assert.equal(r.key_type, 'ed25519');
    assert.equal(r.key_bits, null); // not applicable for Ed25519
    assert.equal(r.public_key_present, true);
    assert.deepEqual(r.syntax_errors, []);
  });

  it('defaults key_type to rsa when k= tag is absent', () => {
    const r = parseDkimRecord(`v=DKIM1; p=${RSA_2048_B64}`);
    assert.equal(r.key_type, 'rsa');
    assert.equal(r.key_bits, 2048);
    assert.equal(r.parse_success, true);
  });

  it('records version=null when v= tag is absent (not an error per RFC 6376)', () => {
    const r = parseDkimRecord(`k=rsa; p=${RSA_2048_B64}`);
    assert.equal(r.version, null);
    assert.equal(r.parse_success, true);
    assert.deepEqual(r.syntax_errors, []);
  });

  it('parses a revoked key (empty p=) as valid with public_key_present=false', () => {
    const r = parseDkimRecord('v=DKIM1; k=rsa; p=');
    assert.equal(r.parse_success, true); // valid per RFC 6376 §3.6.1
    assert.equal(r.public_key_present, false);
    assert.deepEqual(r.syntax_errors, []);
  });

  it('parses h= hash algorithms', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_2048_B64}; h=sha256:sha1`);
    assert.deepEqual(r.hash_algorithms, ['sha256', 'sha1']);
  });

  it('parses s= service type', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_2048_B64}; s=email`);
    assert.deepEqual(r.service_type, ['email']);
  });

  it('parses t= flags', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_2048_B64}; t=y:s`);
    assert.deepEqual(r.flags, ['y', 's']);
  });

  it('returns null for h=, s=, t= when those tags are absent', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa; p=${RSA_2048_B64}`);
    assert.equal(r.hash_algorithms, null);
    assert.equal(r.service_type, null);
    assert.equal(r.flags, null);
  });
});

// ── parseDkimRecord — syntax errors ───────────────────────────────────────────

describe('parseDkimRecord — syntax errors', () => {
  it('reports INVALID_VERSION when v= is not DKIM1', () => {
    const r = parseDkimRecord(`v=DKIM2; k=rsa; p=${RSA_2048_B64}`);
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors.length, 1);
    assert.equal(r.syntax_errors[0].code, 'INVALID_VERSION');
  });

  it('reports MISSING_P_TAG when p= is absent', () => {
    const r = parseDkimRecord('v=DKIM1; k=rsa');
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors[0].code, 'MISSING_P_TAG');
    assert.equal(r.public_key_present, false);
  });

  it('reports INVALID_BASE64 when p= contains non-base64 characters', () => {
    const r = parseDkimRecord('v=DKIM1; k=rsa; p=NOT!VALID@BASE64#');
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors[0].code, 'INVALID_BASE64');
    assert.equal(r.public_key_present, true); // we detected a value, it just failed to parse
  });

  it('reports KEY_PARSE_ERROR when p= is valid base64 but not a valid DER key', () => {
    const r = parseDkimRecord('v=DKIM1; k=rsa; p=aGVsbG8='); // "hello" in base64, not a key
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors[0].code, 'KEY_PARSE_ERROR');
  });

  it('reports UNKNOWN_KEY_TYPE for unrecognised k= values', () => {
    const r = parseDkimRecord(`v=DKIM1; k=rsa3; p=${RSA_2048_B64}`);
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors[0].code, 'UNKNOWN_KEY_TYPE');
  });

  it('reports EMPTY_RECORD for an empty string', () => {
    const r = parseDkimRecord('');
    assert.equal(r.parse_success, false);
    assert.equal(r.syntax_errors[0].code, 'EMPTY_RECORD');
  });
});

// ── collectDkim — DKIM present ────────────────────────────────────────────────

describe('collectDkim — DKIM present', () => {
  it('returns dkim_present=true when one selector is found', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({ selector1: VALID_RSA_RECORD }),
    });
    assert.equal(r.dkim_present, true);
    assert.equal(r.dkim_collection_status, null);
    assert.equal(r.dkim_record_count, 1);
    assert.deepEqual(r.dkim_selectors_found, ['selector1']);
    assert.equal(r.dkim_keys.length, 1);
    assert.equal(r.dkim_keys[0].selector, 'selector1');
    assert.equal(r.dkim_keys[0].raw_record, VALID_RSA_RECORD);
  });

  it('returns dkim_present=true when multiple selectors are found', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({
        selector1: VALID_RSA_RECORD,
        google:    VALID_ED25519_RECORD,
      }),
    });
    assert.equal(r.dkim_present, true);
    assert.equal(r.dkim_record_count, 2);
    assert.deepEqual(r.dkim_selectors_found, ['selector1', 'google']);
  });

  it('strips www. prefix before querying', async () => {
    let queriedName;
    const spyDns = {
      resolveTxt: async (qname) => {
        queriedName = qname;
        if (qname.includes('selector1._domainkey.example.com')) {
          return [[VALID_RSA_RECORD]];
        }
        throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      },
    };
    const r = await collectDkim('www.example.com', { dnsResolver: spyDns });
    assert.equal(r.dkim_present, true);
    assert(queriedName.includes('._domainkey.example.com'));
  });

  it('returns dkim_present=true even when some probe selectors have DNS errors', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns(
        { default: VALID_RSA_RECORD },
        { selector1: 'ETIMEDOUT', selector2: 'ECONNREFUSED' },
      ),
    });
    assert.equal(r.dkim_present, true);
    assert.equal(r.dkim_record_count, 1);
  });
});

// ── collectDkim — NOT_DETECTED ────────────────────────────────────────────────

describe('collectDkim — NOT_DETECTED', () => {
  it('returns NOT_DETECTED when all probes return ENODATA', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}),
    });
    assert.equal(r.dkim_present, null);
    assert.equal(r.dkim_collection_status, 'NOT_DETECTED');
    assert.equal(r.dkim_record_count, 0);
    assert.deepEqual(r.dkim_selectors_found, []);
  });

  it('returns NOT_DETECTED when probes return a mix of ENODATA and ENOTFOUND', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns(
        {},
        { selector1: 'ENOTFOUND', selector2: 'ENOTFOUND' },
      ),
    });
    assert.equal(r.dkim_collection_status, 'NOT_DETECTED');
    assert.equal(r.dkim_record_count, 0);
  });

  it('records dkim_record_count=0 (not null) for a complete probe with no keys', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}),
    });
    assert.equal(r.dkim_record_count, 0);
  });
});

// ── collectDkim — DNS errors ──────────────────────────────────────────────────

describe('collectDkim — DNS errors', () => {
  it('returns DNS_TIMEOUT when at least one probe times out and no key found', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}, { selector1: 'ETIMEDOUT' }),
    });
    assert.equal(r.dkim_present, null);
    assert.equal(r.dkim_collection_status, 'DNS_TIMEOUT');
    assert.equal(r.dkim_record_count, null);
  });

  it('returns DNS_SERVFAIL for ESERVFAIL errors', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}, { selector1: 'ESERVFAIL' }),
    });
    assert.equal(r.dkim_collection_status, 'DNS_SERVFAIL');
  });

  it('returns DNS_FAILURE for other DNS errors', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}, { selector1: 'ECONNREFUSED' }),
    });
    assert.equal(r.dkim_collection_status, 'DNS_FAILURE');
  });

  it('reports the highest priority error when multiple error types occur', async () => {
    // DNS_FAILURE (priority 3) wins over DNS_TIMEOUT (priority 1)
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns(
        {},
        { selector1: 'ETIMEDOUT', selector2: 'ECONNREFUSED' },
      ),
    });
    assert.equal(r.dkim_collection_status, 'DNS_FAILURE');
  });
});

// ── collectDkim — output schema ───────────────────────────────────────────────

describe('collectDkim — output schema', () => {
  it('returns exactly the expected domain-level keys', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({ selector1: VALID_RSA_RECORD }),
    });
    const EXPECTED_KEYS = new Set([
      'dkim_present', 'dkim_collection_status', 'dkim_record_count',
      'dkim_selectors_probed', 'dkim_selectors_found', 'dkim_probe_set_version',
      'dkim_keys',
    ]);
    assert.deepEqual(new Set(Object.keys(r)), EXPECTED_KEYS);
  });

  it('returns exactly the expected key-level keys in each dkim_keys entry', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({ selector1: VALID_RSA_RECORD }),
    });
    const EXPECTED_KEY_FIELDS = new Set([
      'selector', 'raw_record', 'parse_success', 'version',
      'key_type', 'key_bits', 'public_key_present', 'hash_algorithms',
      'service_type', 'flags', 'syntax_errors',
    ]);
    assert.deepEqual(new Set(Object.keys(r.dkim_keys[0])), EXPECTED_KEY_FIELDS);
  });

  it('dkim_selectors_probed contains all 20 probe selectors', async () => {
    const r = await collectDkim('example.com', {
      dnsResolver: makeDns({}),
    });
    assert.equal(r.dkim_selectors_probed.length, PROBE_SELECTORS.length);
    assert.deepEqual(r.dkim_selectors_probed, PROBE_SELECTORS);
  });

  it('schema is consistent across present and null states', async () => {
    const present = await collectDkim('example.com', {
      dnsResolver: makeDns({ selector1: VALID_RSA_RECORD }),
    });
    const notDetected = await collectDkim('example.com', {
      dnsResolver: makeDns({}),
    });
    assert.deepEqual(
      new Set(Object.keys(present)),
      new Set(Object.keys(notDetected)),
    );
  });
});
