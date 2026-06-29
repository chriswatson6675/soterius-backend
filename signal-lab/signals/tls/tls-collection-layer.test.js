'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tls    = require('tls');

const { createRunContext, collectTLSSession } = require('./tls-collection-layer');

// ── Mock socket factory ───────────────────────────────────────────────────────

const { EventEmitter } = require('events');

function makeMockSocket(opts = {}) {
  const socket = new EventEmitter();
  socket.getProtocol = () => opts.protocol  ?? 'TLSv1.3';
  socket.getCipher   = () => opts.cipher    ?? { name: 'TLS_AES_256_GCM_SHA384', standardName: 'TLS_AES_256_GCM_SHA384' };
  socket.alpnProtocol        = opts.alpnProtocol        ?? 'h2';
  socket.authorized          = opts.authorized          ?? true;
  socket.authorizationError  = opts.authorizationError  ?? null;
  socket.getPeerCertificate  = () => opts.peerCert      ?? makeLeafCert();
  socket.destroy = () => {};
  return socket;
}

function makeLeafCert(overrides = {}) {
  return {
    fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    subject: { CN: 'example.com', O: 'Example Corp' },
    issuer:  { CN: 'R3',          O: "Let's Encrypt" },
    subjectaltname: 'DNS:example.com, DNS:www.example.com',
    serialNumber: 'ABCDEF1234567890',
    sigalg: 'sha256WithRSAEncryption',
    bits: 2048,
    valid_from: 'Jan  1 00:00:00 2024 GMT',
    valid_to:   'Jan  1 00:00:00 2099 GMT',
    ca: false,
    infoAccess: {
      'OCSP - URI':       'http://ocsp.example.com',
      'CA Issuers - URI': 'http://ca.example.com/cert.crt',
    },
    issuerCertificate: null,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let savedConnect;
let connectCallCount = 0;

function installConnect(socketFactory) {
  connectCallCount = 0;
  tls.connect = (...args) => {
    connectCallCount++;
    return socketFactory(...args);
  };
}

function emitNextTick(socket, event, ...args) {
  setImmediate(() => socket.emit(event, ...args));
}

async function collect(domain, socketOpts = {}, contextOpts = {}) {
  const ctx = createRunContext();
  let socket;
  installConnect(() => {
    socket = makeMockSocket(socketOpts);
    emitNextTick(socket, 'secureConnect');
    return socket;
  });
  return collectTLSSession(domain, ctx);
}

// ── Category 1 — Outcome path tests (8 tests) ────────────────────────────────

describe('outcome paths', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('RESPONSE_OBSERVED: TLS 1.3, h2, valid cert', async () => {
    const result = await collect('example.com');
    assert.equal(result.endpoint_state,          'RESPONSE_OBSERVED');
    assert.equal(result.connection_error_code,   null);
    assert.equal(result.negotiated_version,      'TLSv1.3');
    assert.equal(result.cipher_suite_openssl,    'TLS_AES_256_GCM_SHA384');
    assert.equal(result.cipher_key_exchange,     'TLS13');
    assert.equal(result.forward_secrecy,         true);
    assert.equal(result.alpn_protocol,           'h2');
    assert.equal(result.http2_negotiated,        true);
    assert.equal(result.certificate_present,     'CERTIFICATE_PRESENTED');
    assert.equal(result.tls_verification_result, 'CHAIN_VERIFIED');
    assert.equal(result.tls_error_code,          null);
    assert.equal(result.collection_hostname,     'example.com');
    assert.ok(typeof result.collected_at === 'string');
  });

  test('RESPONSE_OBSERVED: expired cert maps to CERT_EXPIRED', async () => {
    const result = await collect('example.com', {
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
    });
    assert.equal(result.endpoint_state,          'RESPONSE_OBSERVED');
    assert.equal(result.tls_verification_result, 'CERT_EXPIRED');
    assert.equal(result.tls_error_code,          'CERT_HAS_EXPIRED');
    assert.equal(result.certificate_present,     'CERTIFICATE_PRESENTED');
  });

  test('RESPONSE_OBSERVED: self-signed cert maps to SELF_SIGNED', async () => {
    const selfSignedFp = 'CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB';
    const selfCert = makeLeafCert({
      fingerprint256: selfSignedFp,
      issuerCertificate: { fingerprint256: selfSignedFp }, // self-referential
    });
    const result = await collect('example.com', {
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      peerCert: selfCert,
    });
    assert.equal(result.endpoint_state,          'RESPONSE_OBSERVED');
    assert.equal(result.tls_verification_result, 'SELF_SIGNED');
    assert.equal(result.leaf_is_self_signed,     true);
  });

  test('TLS_ERROR: SSL handshake failure', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('SSL handshake failure'), { code: 'ERR_SSL_HANDSHAKE_FAILURE' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    assert.equal(result.endpoint_state,        'TLS_ERROR');
    assert.equal(result.connection_error_code, 'ERR_SSL_HANDSHAKE_FAILURE');
    assert.equal(result.certificate_present,   null);
    assert.equal(result.negotiated_version,    null);
  });

  test('CONNECTION_ERROR: ECONNREFUSED', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    assert.equal(result.endpoint_state,        'CONNECTION_ERROR');
    assert.equal(result.connection_error_code, 'ECONNREFUSED');
  });

  test('CONNECTION_ERROR: ENOTFOUND (DNS failure)', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    assert.equal(result.endpoint_state,        'CONNECTION_ERROR');
    assert.equal(result.connection_error_code, 'ENOTFOUND');
  });

  test('CONNECTION_ERROR: timeout event maps to ETIMEDOUT', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'timeout');
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    assert.equal(result.endpoint_state,        'CONNECTION_ERROR');
    assert.equal(result.connection_error_code, 'ETIMEDOUT');
  });

  test('CONNECTION_ERROR: ECONNRESET', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    assert.equal(result.endpoint_state,        'CONNECTION_ERROR');
    assert.equal(result.connection_error_code, 'ECONNRESET');
  });
});

// ── Category 2 — C-1 compliance tests (4 tests) ──────────────────────────────

describe('C-1 compliance', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('concurrent calls for same domain share one TLS session', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });

    const [r1, r2] = await Promise.all([
      collectTLSSession('example.com', ctx),
      collectTLSSession('example.com', ctx),
    ]);

    assert.equal(connectCallCount, 1, 'tls.connect called exactly once');
    assert.strictEqual(r1, r2, 'Both results are the same object reference');
  });

  test('sequential calls for same domain in same context reuse session', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });

    const r1 = await collectTLSSession('example.com', ctx);
    const r2 = await collectTLSSession('example.com', ctx);

    assert.equal(connectCallCount, 1, 'tls.connect called exactly once');
    assert.strictEqual(r1, r2, 'Second call returns the same resolved object');
  });

  test('different domains in same context each get one session', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });

    await Promise.all([
      collectTLSSession('alpha.com', ctx),
      collectTLSSession('beta.com',  ctx),
    ]);

    assert.equal(connectCallCount, 2, 'tls.connect called once per distinct domain');
  });

  test('same domain in different RunContexts each get independent sessions', async () => {
    const ctx1 = createRunContext();
    const ctx2 = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });

    await Promise.all([
      collectTLSSession('example.com', ctx1),
      collectTLSSession('example.com', ctx2),
    ]);

    assert.equal(connectCallCount, 2, 'Independent contexts do not share sessions');
  });
});

// ── Category 3 — Cipher suite derivation (5 tests) ───────────────────────────

describe('cipher suite derivation', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('TLS 1.3 cipher: TLS_AES_256_GCM_SHA384', async () => {
    const result = await collect('example.com', {
      protocol: 'TLSv1.3',
      cipher: { name: 'TLS_AES_256_GCM_SHA384', standardName: 'TLS_AES_256_GCM_SHA384' },
    });
    assert.equal(result.cipher_key_exchange,  'TLS13');
    assert.equal(result.cipher_symmetric_alg, 'AES_256_GCM');
    assert.equal(result.cipher_mac_hash,      'SHA384');
    assert.equal(result.forward_secrecy,      true);
  });

  test('TLS 1.2 ECDHE cipher: ECDHE-RSA-AES256-GCM-SHA384', async () => {
    const result = await collect('example.com', {
      protocol: 'TLSv1.2',
      cipher: { name: 'ECDHE-RSA-AES256-GCM-SHA384', standardName: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384' },
    });
    assert.equal(result.cipher_key_exchange,  'ECDHE');
    assert.equal(result.cipher_symmetric_alg, 'AES256-GCM');
    assert.equal(result.cipher_mac_hash,      'SHA384');
    assert.equal(result.forward_secrecy,      true);
  });

  test('TLS 1.2 DHE cipher: DHE-RSA-AES256-SHA256', async () => {
    const result = await collect('example.com', {
      protocol: 'TLSv1.2',
      cipher: { name: 'DHE-RSA-AES256-SHA256', standardName: 'TLS_DHE_RSA_WITH_AES_256_CBC_SHA256' },
    });
    assert.equal(result.cipher_key_exchange, 'DHE');
    assert.equal(result.forward_secrecy,     true);
  });

  test('TLS 1.2 RSA cipher: RSA-AES256-SHA produces forward_secrecy=false', async () => {
    const result = await collect('example.com', {
      protocol: 'TLSv1.2',
      cipher: { name: 'RSA-AES256-SHA', standardName: 'TLS_RSA_WITH_AES_256_CBC_SHA' },
    });
    assert.equal(result.cipher_key_exchange, 'RSA');
    assert.equal(result.forward_secrecy,     false);
  });

  test('unparseable cipher: all derived fields are null', async () => {
    const result = await collect('example.com', {
      protocol: 'TLSv1.2',
      cipher: { name: 'UNKNOWN-FUTURE-CIPHER-SHA256', standardName: null },
    });
    assert.equal(result.cipher_key_exchange,  null);
    assert.equal(result.cipher_symmetric_alg, null);
    assert.equal(result.cipher_mac_hash,      null);
    assert.equal(result.forward_secrecy,      null);
    assert.equal(result.cipher_suite_openssl, 'UNKNOWN-FUTURE-CIPHER-SHA256');
  });
});

// ── Category 4 — ALPN tests (3 tests) ────────────────────────────────────────

describe('ALPN negotiation', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('h2: alpn_protocol=h2, http2_negotiated=true', async () => {
    const result = await collect('example.com', { alpnProtocol: 'h2' });
    assert.equal(result.alpn_protocol,   'h2');
    assert.equal(result.http2_negotiated, true);
  });

  test('http/1.1: alpn_protocol=http/1.1, http2_negotiated=false', async () => {
    const result = await collect('example.com', { alpnProtocol: 'http/1.1' });
    assert.equal(result.alpn_protocol,   'http/1.1');
    assert.equal(result.http2_negotiated, false);
  });

  test('not negotiated (false): both fields null', async () => {
    const result = await collect('example.com', { alpnProtocol: false });
    assert.equal(result.alpn_protocol,   null);
    assert.equal(result.http2_negotiated, null);
  });
});

// ── Category 5 — Certificate field tests (8 tests) ───────────────────────────

describe('certificate fields', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('fingerprint256 is normalised to hex without colons, lowercase', async () => {
    // 32 pairs = 32 bytes = valid SHA-256 fingerprint
    const result = await collect('example.com', {
      peerCert: makeLeafCert({
        fingerprint256: 'AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90:AB:CD:EF:12:34:56:78:90',
      }),
    });
    assert.equal(result.leaf_fingerprint_sha256, 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890');
    assert.ok(!/:/g.test(result.leaf_fingerprint_sha256));
    assert.equal(result.leaf_fingerprint_sha256, result.leaf_fingerprint_sha256.toLowerCase());
  });

  test('valid_from / valid_to are converted to ISO 8601 UTC', async () => {
    const result = await collect('example.com', {
      peerCert: makeLeafCert({
        valid_from: 'Sep  1 00:00:00 2020 GMT',
        valid_to:   'Sep  1 00:00:00 2025 GMT',
      }),
    });
    assert.equal(result.leaf_not_before, '2020-09-01T00:00:00.000Z');
    assert.equal(result.leaf_not_after,  '2025-09-01T00:00:00.000Z');
  });

  test('leaf_days_remaining is negative for already-expired cert', async () => {
    const result = await collect('example.com', {
      authorized: false,
      authorizationError: 'CERT_HAS_EXPIRED',
      peerCert: makeLeafCert({
        valid_from: 'Jan  1 00:00:00 2020 GMT',
        valid_to:   'Jan  1 00:00:00 2021 GMT',
      }),
    });
    assert.ok(result.leaf_days_remaining < 0, 'days_remaining must be negative for expired cert');
    assert.ok(typeof result.leaf_lifetime_days === 'number');
  });

  test('SAN parsing: DNS, DNS:wildcard, IP Address', async () => {
    const result = await collect('example.com', {
      peerCert: makeLeafCert({
        subjectaltname: 'DNS:example.com, DNS:*.example.com, IP Address:192.168.1.1',
      }),
    });
    assert.deepEqual(result.leaf_san_entries, ['example.com', '*.example.com', '192.168.1.1']);
    assert.equal(result.leaf_san_count, 3);
    assert.equal(result.leaf_is_wildcard, true);
  });

  test('SAN absent: san_entries is empty array, san_count=0', async () => {
    const result = await collect('example.com', {
      peerCert: makeLeafCert({ subjectaltname: undefined }),
    });
    assert.deepEqual(result.leaf_san_entries, []);
    assert.equal(result.leaf_san_count,  0);
    assert.equal(result.leaf_is_wildcard, null);
  });

  test('self-signed cert detected by fingerprint comparison', async () => {
    const fp = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
    const result = await collect('example.com', {
      authorized: false,
      authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      peerCert: makeLeafCert({
        fingerprint256: fp,
        issuerCertificate: { fingerprint256: fp },
      }),
    });
    assert.equal(result.leaf_is_self_signed, true);
  });

  test('AIA fields populated when infoAccess present', async () => {
    const result = await collect('example.com', {
      peerCert: makeLeafCert({
        infoAccess: {
          'OCSP - URI':       'http://ocsp.example.com',
          'CA Issuers - URI': 'http://ca.example.com/cert.crt',
        },
      }),
    });
    assert.deepEqual(result.leaf_aia_ocsp_urls,      ['http://ocsp.example.com']);
    assert.deepEqual(result.leaf_aia_ca_issuers_urls, ['http://ca.example.com/cert.crt']);
  });

  test('AIA fields are empty arrays when infoAccess absent', async () => {
    const result = await collect('example.com', {
      peerCert: makeLeafCert({ infoAccess: undefined }),
    });
    assert.deepEqual(result.leaf_aia_ocsp_urls,      []);
    assert.deepEqual(result.leaf_aia_ca_issuers_urls, []);
  });
});

// ── Category 6 — Null completeness test (1 test) ─────────────────────────────

describe('null completeness', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  const EXPECTED_KEYS = [
    'endpoint_state', 'collected_at', 'collection_hostname', 'connection_error_code', 'connection_error_msg',
    'negotiated_version', 'cipher_suite_openssl', 'cipher_suite_standard',
    'cipher_key_exchange', 'cipher_symmetric_alg', 'cipher_mac_hash', 'forward_secrecy',
    'alpn_protocol', 'http2_negotiated',
    'certificate_present', 'tls_verification_result', 'tls_error_code',
    'leaf_subject_cn', 'leaf_subject_o', 'leaf_subject_dn_raw',
    'leaf_issuer_cn', 'leaf_issuer_o', 'leaf_issuer_dn_raw',
    'leaf_serial_number', 'leaf_fingerprint_sha256', 'leaf_signature_algorithm',
    'leaf_key_type', 'leaf_key_bits', 'leaf_key_curve',
    'leaf_not_before', 'leaf_not_after', 'leaf_days_remaining', 'leaf_lifetime_days',
    'leaf_san_entries', 'leaf_san_count', 'leaf_is_wildcard', 'leaf_is_self_signed',
    'leaf_aia_ocsp_urls', 'leaf_aia_ca_issuers_urls', 'leaf_policy_oids',
    'leaf_basic_constraints_ca', 'leaf_basic_constraints_pathlen', 'leaf_extension_parse_errors',
    'chain_intermediates', 'cert_chain_depth', 'cert_chain_complete',
    'session_ticket_issued', 'ocsp_stapling_present', 'key_share_group',
  ];

  test('all evidence keys present for RESPONSE_OBSERVED', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    for (const key of EXPECTED_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `Missing key: ${key}`);
    }
  });

  test('all evidence keys present for CONNECTION_ERROR', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    for (const key of EXPECTED_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `Missing key: ${key}`);
    }
  });

  test('all evidence keys present for TLS_ERROR', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('TLS error'), { code: 'ERR_SSL_PROTOCOL_ERROR' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const result = await collectTLSSession('example.com', ctx);
    for (const key of EXPECTED_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, key), `Missing key: ${key}`);
    }
  });
});

// ── Category 7 — Error never propagates (2 tests) ────────────────────────────

describe('error propagation', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  test('collectTLSSession always resolves, never rejects', async () => {
    const ctx = createRunContext();
    installConnect(() => {
      const socket = makeMockSocket({
        peerCert: makeLeafCert(),
      });
      // Override getPeerCertificate to throw unexpectedly
      socket.getPeerCertificate = () => { throw new Error('Simulated extraction error'); };
      emitNextTick(socket, 'secureConnect');
      return socket;
    });

    // Must resolve, not reject
    const result = await collectTLSSession('example.com', ctx);
    assert.ok(typeof result.endpoint_state === 'string', 'Result must have endpoint_state');
  });

  test('future-fields are always null in v1 across all outcome paths', async () => {
    const ctx1 = createRunContext();
    const ctx2 = createRunContext();
    const ctx3 = createRunContext();

    installConnect(() => {
      const socket = makeMockSocket();
      emitNextTick(socket, 'secureConnect');
      return socket;
    });
    const success = await collectTLSSession('example.com', ctx1);

    tls.connect = savedConnect; // temporarily restore
    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const connErr = await collectTLSSession('other.com', ctx2);

    installConnect(() => {
      const socket = makeMockSocket();
      const err = Object.assign(new Error('tls err'), { code: 'ERR_SSL_VERSION_TOO_LOW' });
      emitNextTick(socket, 'error', err);
      return socket;
    });
    const tlsErr = await collectTLSSession('third.com', ctx3);

    for (const result of [success, connErr, tlsErr]) {
      assert.equal(result.session_ticket_issued, null);
      assert.equal(result.ocsp_stapling_present, null);
      assert.equal(result.key_share_group,       null);
    }
  });
});

// ── Additional verification mapping tests ────────────────────────────────────

describe('verification result mapping', () => {
  before(() => { savedConnect = tls.connect; });
  after(() => { tls.connect = savedConnect; });

  const verificationCases = [
    ['CERT_HAS_EXPIRED',                   'CERT_EXPIRED'],
    ['CERT_NOT_YET_VALID',                 'CERT_NOT_YET_VALID'],
    ['ERR_TLS_CERT_ALTNAME_INVALID',       'HOSTNAME_MISMATCH'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT',        'SELF_SIGNED'],
    ['SELF_SIGNED_CERT_IN_CHAIN',          'SELF_SIGNED_IN_CHAIN'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE',    'CHAIN_UNVERIFIABLE'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY',  'CHAIN_UNVERIFIABLE'],
    ['CERT_REVOKED',                       'CERT_REVOKED'],
    ['SOME_UNKNOWN_TLS_ERROR',             'OTHER_TLS_ERROR'],
  ];

  for (const [errorCode, expectedResult] of verificationCases) {
    test(`authorizationError '${errorCode}' maps to '${expectedResult}'`, async () => {
      const ctx = createRunContext();
      installConnect(() => {
        const socket = makeMockSocket({ authorized: false, authorizationError: errorCode });
        emitNextTick(socket, 'secureConnect');
        return socket;
      });
      const result = await collectTLSSession('example.com', ctx);
      assert.equal(result.tls_verification_result, expectedResult);
      assert.equal(result.tls_error_code,          errorCode);
    });
  }
});

// ── createRunContext tests ────────────────────────────────────────────────────

describe('createRunContext', () => {
  test('returns object with sessions Map', () => {
    const ctx = createRunContext();
    assert.ok(ctx.sessions instanceof Map);
    assert.equal(ctx.sessions.size, 0);
  });

  test('two contexts are independent', () => {
    const ctx1 = createRunContext();
    const ctx2 = createRunContext();
    assert.notStrictEqual(ctx1, ctx2);
    assert.notStrictEqual(ctx1.sessions, ctx2.sessions);
  });
});
